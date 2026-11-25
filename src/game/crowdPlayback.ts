// Crowd playback: turns the engine's crowd record into what the sky shows at time t.
//
// Nothing here decides what happens to a kite. The engine's record says, for every
// tick (one CloudWatch minute), how many Cloudlings are there, how many kites were
// answered or timed out, how many instances are serving or launching, and what the
// alarms did. This file only places those numbers on the ground and on the clock, as
// pure functions, so the same run always plays the same way and reduced-motion mode
// can simply ask for the last frame.
//
// The pace is deliberately slow (ADR 0012): a minute lasts 1.25 s on screen, and the
// level's groups arrive four minutes (5 s) apart. Each Cloudling keeps one kite up for
// as long as it stays, on a long string all the way to the load balancer, as kites
// reach their cloud in every other level (ADR 0013). A kite with room stays attached;
// a kite with no room is knocked loose and falls to the ground, and rises again when
// there is room. New arrivals walk on and send their kites up before they count;
// leavers reel their kites in and walk off.

import { failingStep, LAUNCH_TICKS, type CrowdRecord, type Scene, type TickRecord } from '../engine'
import type { Kite } from '../levels'
import { cloudlingPosition, positionOfRef, SKY, type Point, type SceneLayout } from './layout'
import type { SoundId } from './sound'

/** How long one simulation tick (one CloudWatch minute) lasts on screen, in milliseconds. */
export const TICK_DURATION = 1250
/** A pause after the last minute, so the final state can be seen before the run ends. */
const SETTLE_DURATION = 1500
/** Minutes a newcomer spends walking on and sending its kite up before it counts. */
export const WALK_TICKS = 2
/** Minutes a kite takes to float from its Cloudling's hand up to the load balancer, or to be reeled in. */
export const RISE_TICKS = 0.6
/** Share of a minute a kite takes to fall when it is knocked loose, or to rise again. */
export const FALL = 0.5
/** Within a minute: kites rise or sag, and the dial's needle moves, until this fraction. */
export const SETTLE = 0.35
/**
 * Within a minute: when CloudWatch's alarm changes state, the bell rings and the group
 * starts or removes instances. Its decisions are taken on the minute's CPU.
 */
export const ALARM_AT = 0.55

export type CrowdFate = 'delivered' | 'timed-out' | 'blocked'

export function crowdRunDuration(record: CrowdRecord): number {
  return record.ticks.length * TICK_DURATION + SETTLE_DURATION
}

export type CrowdFrame = {
  /** Which minute is on show. */
  index: number
  tick: TickRecord
  /** The minute before this one; null on the first. */
  previous: TickRecord | null
  /** 0 to 1 through the current minute; 1 once the run is over. */
  progress: number
}

/** Which minute is on show at `time` (milliseconds since the run began), and how far through it. */
export function crowdFrameAt(record: CrowdRecord, time: number): CrowdFrame | null {
  const last = record.ticks.length - 1
  if (last < 0) return null
  const index = Math.min(last, Math.max(0, Math.floor(time / TICK_DURATION)))
  const progress = time >= record.ticks.length * TICK_DURATION ? 1 : (time / TICK_DURATION) % 1
  return {
    index,
    tick: record.ticks[index]!,
    previous: index > 0 ? record.ticks[index - 1]! : null,
    progress,
  }
}

const ease = (amount: number): number => {
  const clamped = Math.min(1, Math.max(0, amount))
  return clamped * clamped * (3 - 2 * clamped)
}

/**
 * The fate of crowd member `member` on this tick, or null if they are not there.
 * Members 0 to demand−1 are present. Timed-out kites are spread evenly through the
 * crowd, so a shortfall shows everywhere rather than at one end of the field.
 */
export function fateOf(member: number, tick: TickRecord): CrowdFate | null {
  if (member >= tick.demand) return null
  if (tick.blocked > 0) return 'blocked'
  // The same even spreading a line-drawing routine uses: member m times out when the
  // running share of timeouts steps up between m and m + 1.
  const before = Math.floor((member * tick.dropped) / tick.demand)
  const after = Math.floor(((member + 1) * tick.dropped) / tick.demand)
  return after > before ? 'timed-out' : 'delivered'
}

/**
 * Where the CloudWatch weather station stands: the right-hand end of the ground, below
 * the open sky right of the VPC, where its readout has room.
 */
export const WEATHER_STATION: Point = { x: 940, y: SKY.groundY }

/**
 * Where each crowd member stands. The level's named Cloudlings are the regulars and
 * keep their own places; everyone else fills two rows, from the middle outwards, so
 * the crowd grows around them. Both rows stop short of the weather station on the
 * right. There are places for MAX_CROWD (levels/schema.ts) and a few more.
 */
export function crowdSpots(population: Kite[]): Point[] {
  const regulars = population.map((kite) => cloudlingPosition(kite.groundPosition))
  const start = SKY.left + 40
  const end = WEATHER_STATION.x - 46
  const middle = (start + end) / 2
  const rows = [
    { row: 0, feetY: SKY.groundY, from: start, to: end },
    { row: 1, feetY: SKY.groundY - 24, from: start + 16, to: end },
  ]
  const candidates: (Point & { order: number })[] = []
  for (const { row, feetY, from, to } of rows) {
    for (let x = from; x <= to; x += 30) {
      if (regulars.some((spot) => Math.abs(spot.x - x) < 28 && spot.y === feetY)) continue
      candidates.push({ x, y: feetY, order: Math.abs(x - middle) + row * 12 })
    }
  }
  candidates.sort((first, second) => first.order - second.order)
  return [...regulars, ...candidates.map(({ x, y }) => ({ x, y }))]
}

// ---------------------------------------------------------------------------
// One Cloudling in the crowd
// ---------------------------------------------------------------------------

export type MemberView = {
  /** Where its feet are. */
  feet: Point
  /** Walking on or off: its kite is in its hand. */
  walking: boolean
  /** 0 = kite in hand, 1 = kite up at the load balancer. */
  aloft: number
  /** 0 = attached at the load balancer, 1 = fallen to the ground: a kite with no room falls. */
  sag: number
  /** The fate of its kite this minute, or null while it walks. */
  fate: CrowdFate | null
  /** 0 to 1: faded in from the edge of the field, out as it leaves. */
  opacity: number
}

/** The minutes at which a member arrives and leaves: arrival is the first minute it counts. */
export function memberVisits(
  record: CrowdRecord,
  member: number,
): { arrive: number; leave: number | null }[] {
  const visits: { arrive: number; leave: number | null }[] = []
  record.ticks.forEach((tick, index) => {
    const here = member < tick.demand
    const before = index > 0 && member < record.ticks[index - 1]!.demand
    if (here && !before) visits.push({ arrive: index, leave: null })
    if (!here && before) {
      const visit = visits.at(-1)
      if (visit) visit.leave = index
    }
  })
  return visits
}

/**
 * What one crowd member is doing at `time`, or null if it is not on the field.
 *
 * - The regulars are at their places from the start; their kites float up to the load
 *   balancer during the first minute.
 * - A newcomer walks in from the nearer edge, each a little after the one before, then
 *   sends its kite up, so the kite reaches the load balancer just as the minute it
 *   counts begins.
 * - On each minute a kite takes that minute's fate: with room it stays attached; with no
 *   room it falls to the ground beside its Cloudling; when room comes back it rises again.
 * - A leaver reels its kite in, then walks back out, fading.
 */
export function memberViewAt(
  record: CrowdRecord,
  member: number,
  spot: Point,
  time: number,
): MemberView | null {
  const minute = time / TICK_DURATION
  const index = Math.min(record.ticks.length - 1, Math.max(0, Math.floor(minute)))
  const progress = minute - index
  const finished = time >= record.ticks.length * TICK_DURATION
  const edgeX = spot.x < (SKY.left + SKY.right) / 2 ? SKY.left - 24 : SKY.right + 24
  const stagger = ((member * 7) % 5) * 0.08
  const walkTo = (from: number, to: number, amount: number): Point => ({
    x: from + (to - from) * ease(amount),
    y: spot.y,
  })
  const sagOf = (fate: CrowdFate | null) => (fate === null || fate === 'delivered' ? 0 : 1)

  for (const visit of memberVisits(record, member)) {
    if (visit.arrive > 0) {
      // Walking on, kite in hand…
      const start = Math.max(0, visit.arrive - WALK_TICKS + stagger)
      const sendUp = visit.arrive - RISE_TICKS
      if (minute >= start && minute < sendUp) {
        const amount = (minute - start) / (sendUp - start)
        return {
          feet: walkTo(edgeX, spot.x, amount),
          walking: true,
          aloft: 0,
          sag: 0,
          fate: null,
          opacity: ease(amount / 0.5),
        }
      }
      // …then, standing at its place, sending the kite up to the load balancer.
      if (minute >= sendUp && minute < visit.arrive) {
        return {
          feet: spot,
          walking: false,
          aloft: ease((minute - sendUp) / RISE_TICKS),
          sag: 0,
          fate: null,
          opacity: 1,
        }
      }
    }
    // Leaving: the kite is reeled in from wherever it is, then the Cloudling walks off.
    if (visit.leave !== null && minute >= visit.leave) {
      const away = minute - visit.leave
      const walkStart = RISE_TICKS + stagger
      const walkEnd = WALK_TICKS + RISE_TICKS
      if (away >= walkEnd) continue
      const reel = ease(away / RISE_TICKS)
      const last = record.ticks[visit.leave - 1]
      const lastSag = last ? sagOf(fateOf(member, last)) : 0
      const amount = Math.max(0, (away - walkStart) / (walkEnd - walkStart))
      return {
        feet: walkTo(spot.x, edgeX, amount),
        walking: amount > 0,
        aloft: 1 - reel,
        sag: lastSag * (1 - reel),
        fate: null,
        opacity: 1 - ease((amount - 0.3) / 0.6),
      }
    }
    // Standing at its place with its kite up.
    if (minute >= visit.arrive && (visit.leave === null || minute < visit.leave)) {
      const tick = record.ticks[index]!
      const fate = fateOf(member, tick) ?? 'delivered'
      // The regulars' kites go up during the first minute; their fate shows once they arrive.
      if (visit.arrive === 0 && index === 0 && !finished && progress < RISE_TICKS) {
        return {
          feet: spot,
          walking: false,
          aloft: ease(progress / RISE_TICKS),
          sag: 0,
          fate,
          opacity: 1,
        }
      }
      const previous = index > visit.arrive ? record.ticks[index - 1]! : null
      // A kite that has just reached the load balancer starts out attached.
      const sagBefore = previous ? sagOf(fateOf(member, previous)) : 0
      const settleFrom = visit.arrive === 0 && index === 0 ? RISE_TICKS : 0
      const settle = finished ? 1 : ease((progress - settleFrom) / FALL)
      return {
        feet: spot,
        walking: false,
        aloft: 1,
        sag: sagBefore + (sagOf(fate) - sagBefore) * settle,
        fate,
        opacity: 1,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// The fleet and the dial
// ---------------------------------------------------------------------------

export type FleetView = {
  /** Instances serving kites. The last `leaving` of them are being removed. */
  serving: number
  /** Instances launching: started, not serving yet. */
  launching: number
  /** 0 to 1: how far the launching instances are through starting up. */
  launchProgress: number
  /** Instances being removed this minute, and how far they have faded (0 to 1). */
  leaving: number
  leaveFade: number
  /** Whether any load balancer sends this group kites. */
  attached: boolean
}

/**
 * An Auto Scaling group at `time`, from the engine's record. Instances the group starts
 * at the end of a minute appear at ALARM_AT, with the alarm; they serve from the minute
 * the record says they do. Instances it removes fade from ALARM_AT to the end of the minute.
 */
export function fleetViewAt(record: CrowdRecord, groupId: string, time: number): FleetView | null {
  const frame = crowdFrameAt(record, time)
  const fleet = frame?.tick.fleets.find((candidate) => candidate.groupId === groupId)
  if (!frame || !fleet) return null
  const acted = frame.progress >= ALARM_AT
  const launching = acted ? fleet.launching : fleet.launching - fleet.started
  // The latest batch of launches: started at ALARM_AT of some minute, serving
  // LAUNCH_TICKS minutes after that minute began.
  let startedAt = -1
  for (let index = frame.index; index >= 0; index--) {
    const earlier = record.ticks[index]?.fleets.find((candidate) => candidate.groupId === groupId)
    if (earlier && earlier.started > 0 && (index < frame.index || acted)) {
      startedAt = index
      break
    }
  }
  const elapsed = startedAt < 0 ? 0 : frame.index + frame.progress - (startedAt + ALARM_AT)
  return {
    serving: fleet.inService,
    launching: Math.max(0, launching),
    launchProgress: Math.min(1, Math.max(0, elapsed / (LAUNCH_TICKS - ALARM_AT))),
    leaving: acted ? fleet.stopped : 0,
    leaveFade: acted ? Math.min(1, (frame.progress - ALARM_AT) / (1 - ALARM_AT)) : 0,
    attached: fleet.attached,
  }
}

/**
 * The CPU the weather station's dial shows at `time`: it moves from the last minute's
 * reading to this minute's over the first part of the minute, rather than jumping.
 */
export function dialCpuAt(record: CrowdRecord, time: number): number {
  const frame = crowdFrameAt(record, time)
  if (!frame) return 0
  const from = frame.previous?.cpuPercent ?? frame.tick.cpuPercent
  return from + (frame.tick.cpuPercent - from) * ease(frame.progress / SETTLE)
}

/**
 * Is the weather station's bell ringing at `time`? It rings when an alarm goes into
 * the ALARM state, at ALARM_AT in the minute that tripped it, for a little under a minute.
 */
export function bellRingingAt(record: CrowdRecord, time: number): boolean {
  return record.ticks.some((tick, index) => {
    const previous = index > 0 ? record.ticks[index - 1]!.alarm : 'ok'
    if (tick.alarm === 'ok' || tick.alarm === previous) return false
    const start = (index + ALARM_AT) * TICK_DURATION
    return time >= start && time < start + 0.8 * TICK_DURATION
  })
}

/** The alarm state on show at `time`: a minute's alarm shows from ALARM_AT, when it is decided. */
export function alarmAt(record: CrowdRecord, time: number): TickRecord['alarm'] {
  const frame = crowdFrameAt(record, time)
  if (!frame) return 'ok'
  if (frame.progress >= ALARM_AT) return frame.tick.alarm
  return frame.previous?.alarm ?? 'ok'
}

// ---------------------------------------------------------------------------
// Where the crowd's kites go
// ---------------------------------------------------------------------------

/**
 * The places a crowd kite passes on its way in, read from the engine's representative
 * journey: up to the load balancer (the trunk every kite shares), then on to each cloud
 * serving kites this minute, or up to the check that stopped the crowd.
 */
export type CrowdStream = {
  trunk: Point[]
  /** One branch per cloud serving kites, with its share of this minute's answered kites. */
  branches: { to: Point; share: number }[]
  /** Where the crowd was stopped, if it was. */
  stoppedAt: Point | null
}

export function crowdStream(
  tick: TickRecord,
  scene: Scene,
  layout: SceneLayout,
  origin: Point,
): CrowdStream {
  const places: Point[] = [origin]
  let previous = origin
  const stop = failingStep(tick.served)
  const steps = stop
    ? tick.served.trace.slice(0, tick.served.trace.indexOf(stop) + 1)
    : tick.served.trace
  for (const step of steps) {
    if (step.leg !== 'request') continue
    // The trunk ends at the load balancer; the branches carry kites on from there.
    if (!stop && step.check === 'target-selection') break
    const place = positionOfRef(scene, layout, step.at, previous, previous)
    const last = places[places.length - 1]!
    if (Math.hypot(last.x - place.x, last.y - place.y) > 4) places.push(place)
    previous = place
  }
  const total = tick.serving.reduce((sum, entry) => sum + entry.capacity, 0)
  const branches = stop
    ? []
    : tick.serving.flatMap((entry) => {
        const rect = layout.clouds[entry.resourceId]
        if (!rect || total === 0) return []
        return [
          {
            to: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
            share: entry.capacity / total,
          },
        ]
      })
  return { trunk: places, branches, stoppedAt: stop ? (places.at(-1) ?? null) : null }
}

/** Where along a path the dot is, for `amount` from 0 (its start) to 1 (its end). */
export function alongPath(path: Point[], amount: number): Point {
  if (path.length === 0) return { x: 0, y: 0 }
  if (path.length === 1 || amount <= 0) return path[0]!
  if (amount >= 1) return path[path.length - 1]!
  const lengths = path.slice(1).map((point, index) => {
    const from = path[index]!
    return Math.hypot(point.x - from.x, point.y - from.y)
  })
  let remaining = amount * lengths.reduce((sum, length) => sum + length, 0)
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!
    const from = path[index]!
    const to = path[index + 1]!
    if (remaining <= length) {
      const fraction = length === 0 ? 1 : remaining / length
      return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction }
    }
    remaining -= length
  }
  return path[path.length - 1]!
}

// ---------------------------------------------------------------------------
// The CloudWatch ticker: what happened, minute by minute
// ---------------------------------------------------------------------------

export type LogEntry = {
  minute: number
  text: string
  kind: 'crowd' | 'alarm' | 'fleet' | 'timeout' | 'info'
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/**
 * CloudWatch's log of the day: one line for each thing that changed. Shown in the side
 * panel as the run plays, so the player can read what the dial and the bell meant.
 */
export function crowdLog(record: CrowdRecord, targetPercent: number | null): LogEntry[] {
  const entries: LogEntry[] = []
  record.ticks.forEach((tick, index) => {
    const previous = index > 0 ? record.ticks[index - 1]! : null
    const minute = index
    const room = `room for ${tick.capacity}`
    if (!previous) {
      entries.push({
        minute,
        kind: 'info',
        text: `${plural(tick.demand, 'Cloudling')}, ${room}: CPU ${tick.cpuPercent}%`,
      })
    } else {
      const change = tick.demand - previous.demand
      if (change !== 0) {
        entries.push({
          minute,
          kind: 'crowd',
          text: `${change > 0 ? `${change} more arrive` : `${-change} go home`}: ${plural(tick.demand, 'Cloudling')}, ${room}, CPU ${tick.cpuPercent}%`,
        })
      }
      if (tick.targetsInService > previous.targetsInService) {
        entries.push({
          minute,
          kind: 'fleet',
          text: `${plural(tick.targetsInService - previous.targetsInService, 'new instance')} serving: ${room}, CPU ${tick.cpuPercent}%`,
        })
      }
    }
    if (tick.dropped > 0 && (previous?.dropped ?? 0) !== tick.dropped) {
      entries.push({
        minute,
        kind: 'timeout',
        text: `${plural(tick.dropped, 'kite')} timed out: no room (HTTP 504)`,
      })
    }
    if (tick.blocked > 0 && (previous?.blocked ?? 0) === 0) {
      entries.push({ minute, kind: 'timeout', text: 'No kite can get through: see the trace' })
    }
    const started = tick.fleets.reduce((sum, fleet) => sum + fleet.started, 0)
    const stopped = tick.fleets.reduce((sum, fleet) => sum + fleet.stopped, 0)
    const target = targetPercent === null ? '' : ` ${targetPercent}%`
    if (tick.alarm !== 'ok' && tick.alarm !== previous?.alarm) {
      entries.push({
        minute,
        kind: 'alarm',
        text:
          tick.alarm === 'high-cpu'
            ? `ALARM: CPU above${target}${started > 0 ? `. Launching ${plural(started, 'instance')}` : ''}`
            : `ALARM: CPU below${target}${stopped > 0 ? `. Removing ${plural(stopped, 'instance')}` : ''}`,
      })
    } else if (started > 0) {
      entries.push({ minute, kind: 'fleet', text: `Launching ${plural(started, 'more instance')}` })
    } else if (stopped > 0) {
      entries.push({ minute, kind: 'fleet', text: `Removing ${plural(stopped, 'instance')}` })
    }
  })
  return entries
}

/** The fleet's size over the day, one number per change: e.g. 2 → 4 → 8 → 16 → 8 → 4 → 2. */
export function fleetSizes(record: CrowdRecord): number[] {
  const sizes: number[] = []
  for (const tick of record.ticks) {
    if (sizes.at(-1) !== tick.targetsInService) sizes.push(tick.targetsInService)
  }
  return sizes
}

/** How many different crowd members had a kite time out at least once during the day. */
export function membersTimedOut(record: CrowdRecord): number {
  const biggest = Math.max(0, ...record.ticks.map((tick) => tick.demand))
  let count = 0
  for (let member = 0; member < biggest; member++) {
    if (record.ticks.some((tick) => fateOf(member, tick) === 'timed-out')) count += 1
  }
  return count
}

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------

/** A sound and how loud, 0 to 1: a crowd is blended into a few voices, never forty. */
export type CrowdCue = { sound: SoundId; volume: number }

/**
 * The sounds of one minute, only for what changed: a cheer as newcomers' kites go up,
 * a groan when more kites time out, the bell when an alarm goes into ALARM, and a
 * shimmer when new instances start serving. A steady minute is quiet.
 */
export function cuesForTick(
  tick: TickRecord,
  previous: TickRecord | null,
): { at: number; cue: CrowdCue }[] {
  const cues: { at: number; cue: CrowdCue }[] = []
  const share = (count: number) => Math.min(1, 0.35 + count / 30)
  const arrived = previous ? tick.demand - previous.demand : 0
  if (arrived > 0) {
    cues.push({
      at: 0.1,
      cue: { sound: arrived >= 6 ? 'crowd-cheer' : 'cheer', volume: share(arrived) },
    })
  }
  const newlyDropped = tick.dropped - (previous?.dropped ?? 0)
  if (tick.dropped > 0 && newlyDropped > 0) {
    cues.push({ at: SETTLE * 0.6, cue: { sound: 'timed-out', volume: share(newlyDropped) } })
    cues.push({
      at: SETTLE,
      cue: {
        sound: newlyDropped >= 4 ? 'crowd-groan' : 'friendly-failed',
        volume: share(newlyDropped),
      },
    })
  }
  if (tick.blocked > 0 && (previous?.blocked ?? 0) === 0) {
    cues.push({ at: SETTLE, cue: { sound: 'crowd-groan', volume: share(tick.blocked) } })
  }
  if (previous && tick.targetsInService > previous.targetsInService) {
    cues.push({ at: 0.02, cue: { sound: 'connected', volume: 0.7 } })
  }
  if (tick.alarm !== 'ok' && tick.alarm !== previous?.alarm) {
    cues.push({ at: ALARM_AT, cue: { sound: 'alarm-bell', volume: 0.8 } })
  }
  return cues
}

/** The cues whose moment falls in the half-open interval (from, to], in run time. */
export function crowdCuesBetween(record: CrowdRecord, from: number, to: number): CrowdCue[] {
  return record.ticks.flatMap((tick, index) =>
    cuesForTick(tick, index > 0 ? record.ticks[index - 1]! : null)
      .filter(({ at }) => {
        const time = (index + at) * TICK_DURATION
        return time > from && time <= to
      })
      .map(({ cue }) => cue),
  )
}
