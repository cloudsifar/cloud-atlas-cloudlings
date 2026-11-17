// Crowd playback: turns the engine's crowd record into what the sky shows at time t.
//
// Nothing here decides what happens to a kite. The engine's record says, for every
// tick, how many kites flew, how many were delivered, timed out or were blocked, and
// gives one representative journey for each. This file only places those numbers on
// the ground and on the clock, as pure functions, so the same run always plays the
// same way and reduced-motion mode can simply ask for the last frame.

import { failingStep, type CrowdRecord, type Scene, type TickRecord } from '../engine'
import type { Kite } from '../levels'
import { cloudlingPosition, positionOfRef, SKY, type Point, type SceneLayout } from './layout'
import type { SoundId } from './sound'

/** How long one simulation tick lasts on screen, in milliseconds. */
export const TICK_DURATION = 520
/** A pause after the last tick, so the final reactions can play before the run ends. */
const SETTLE_DURATION = 700

/** Within a tick: the kites climb until this fraction, then the outcome plays. */
export const ARRIVAL = 0.5

export type CrowdFate = 'delivered' | 'timed-out' | 'blocked'

export function crowdRunDuration(record: CrowdRecord): number {
  return record.ticks.length * TICK_DURATION + SETTLE_DURATION
}

export type CrowdFrame = {
  tick: TickRecord
  /** The tick before this one, for arrivals and departures; null on the first tick. */
  previous: TickRecord | null
  /** 0 to 1 through the current tick. */
  progress: number
}

/** Which tick is on show at `time` (milliseconds since the run began), and how far through it. */
export function crowdFrameAt(record: CrowdRecord, time: number): CrowdFrame | null {
  const last = record.ticks.length - 1
  if (last < 0) return null
  const index = Math.min(last, Math.max(0, Math.floor(time / TICK_DURATION)))
  const progress = time >= record.ticks.length * TICK_DURATION ? 1 : (time / TICK_DURATION) % 1
  return {
    tick: record.ticks[index]!,
    previous: index > 0 ? record.ticks[index - 1]! : null,
    progress,
  }
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

/** Where the CloudWatch weather station stands: the left-hand end of the ground. */
export const WEATHER_STATION: Point = { x: 228, y: SKY.groundY }

/**
 * Where each crowd member stands. The level's named Cloudlings are the regulars and
 * keep their own places; everyone else fills two rows, from the middle outwards, so
 * the crowd grows around them. Both rows stop short of the ground's caption on the
 * right. There are places for about 43; a bigger crowd is counted on the weather
 * station but not all drawn.
 */
export function crowdSpots(population: Kite[]): Point[] {
  const regulars = population.map((kite) => cloudlingPosition(kite.groundPosition))
  const start = WEATHER_STATION.x + 34
  const middle = (start + SKY.right) / 2
  const rows = [
    { row: 0, feetY: SKY.groundY, from: start, to: SKY.right - 150 },
    { row: 1, feetY: SKY.groundY - 24, from: start + 16, to: SKY.right - 150 },
  ]
  const candidates: (Point & { order: number })[] = []
  for (const { row, feetY, from, to } of rows) {
    for (let x = from; x <= to; x += 32) {
      if (regulars.some((spot) => Math.abs(spot.x - x) < 28 && spot.y === feetY)) continue
      candidates.push({ x, y: feetY, order: Math.abs(x - middle) + row * 12 })
    }
  }
  candidates.sort((first, second) => first.order - second.order)
  return [...regulars, ...candidates.map(({ x, y }) => ({ x, y }))]
}

/**
 * Is the weather station's bell ringing at `time`? It rings when an alarm goes into
 * the ALARM state, at the end of the tick that tripped it, for a little under a tick.
 */
export function bellRingingAt(record: CrowdRecord, time: number): boolean {
  return record.ticks.some((tick, index) => {
    const previous = index > 0 ? record.ticks[index - 1]!.alarm : 'ok'
    if (tick.alarm === 'ok' || tick.alarm === previous) return false
    const start = (index + 0.85) * TICK_DURATION
    return time >= start && time < start + 0.8 * TICK_DURATION
  })
}

/**
 * The places a crowd kite passes on its way in, read from the engine's representative
 * journeys: up to the load balancer for a kite that times out, up to the target for one
 * that is served, up to the failing check for one that is blocked.
 */
export type CrowdPaths = Record<CrowdFate, Point[]>

export function crowdPaths(tick: TickRecord, scene: Scene, layout: SceneLayout): CrowdPaths {
  const placesOf = (steps: TickRecord['served']['trace']): Point[] => {
    const places: Point[] = []
    let previous: Point = { x: (SKY.left + SKY.right) / 2, y: SKY.groundY - 90 }
    for (const step of steps) {
      if (step.leg !== 'request') continue
      const place = positionOfRef(scene, layout, step.at, previous, previous)
      const last = places[places.length - 1]
      if (!last || Math.hypot(last.x - place.x, last.y - place.y) > 4) places.push(place)
      previous = place
    }
    return places
  }
  const stop = failingStep(tick.served)
  const blockedSteps = stop
    ? tick.served.trace.slice(0, tick.served.trace.indexOf(stop) + 1)
    : tick.served.trace
  return {
    delivered: placesOf(tick.served.trace),
    'timed-out': placesOf(tick.timedOut?.trace ?? tick.served.trace.slice(0, 1)),
    blocked: placesOf(blockedSteps),
  }
}

/** Where along a path the kite is, for `amount` from 0 (its resting place) to 1 (the end). */
export function alongPath(rest: Point, path: Point[], amount: number): Point {
  const points = [rest, ...path]
  if (points.length === 1 || amount <= 0) return rest
  if (amount >= 1) return points[points.length - 1]!
  const lengths = points.slice(1).map((point, index) => {
    const from = points[index]!
    return Math.hypot(point.x - from.x, point.y - from.y)
  })
  let remaining = amount * lengths.reduce((sum, length) => sum + length, 0)
  for (let index = 0; index < lengths.length; index++) {
    const length = lengths[index]!
    const from = points[index]!
    const to = points[index + 1]!
    if (remaining <= length) {
      const fraction = length === 0 ? 1 : remaining / length
      return { x: from.x + (to.x - from.x) * fraction, y: from.y + (to.y - from.y) * fraction }
    }
    remaining -= length
  }
  return points[points.length - 1]!
}

/** A sound and how loud, 0 to 1: a crowd is blended into a few voices, never forty. */
export type CrowdCue = { sound: SoundId; volume: number }

/**
 * The sounds of one tick. Forty deliveries are one pop and one crowd cheer, louder for
 * a bigger crowd; forty timeouts are one "fwoop" and one crowd groan. The weather
 * station's bell rings when an alarm goes into ALARM, and a shimmer marks new
 * instances joining the load balancer.
 */
export function cuesForTick(
  tick: TickRecord,
  previous: TickRecord | null,
): { at: number; cue: CrowdCue }[] {
  const cues: { at: number; cue: CrowdCue }[] = []
  const share = (count: number) => Math.min(1, 0.35 + count / 40)
  if (tick.delivered > 0) {
    cues.push({ at: ARRIVAL, cue: { sound: 'delivered', volume: share(tick.delivered) } })
    cues.push({
      at: ARRIVAL + 0.12,
      cue: { sound: tick.delivered >= 6 ? 'crowd-cheer' : 'cheer', volume: share(tick.delivered) },
    })
  }
  if (tick.dropped > 0) {
    cues.push({ at: ARRIVAL + 0.05, cue: { sound: 'timed-out', volume: share(tick.dropped) } })
    cues.push({
      at: ARRIVAL + 0.3,
      cue: {
        sound: tick.dropped >= 4 ? 'crowd-groan' : 'friendly-failed',
        volume: share(tick.dropped),
      },
    })
  }
  if (tick.blocked > 0) {
    cues.push({ at: ARRIVAL + 0.3, cue: { sound: 'crowd-groan', volume: share(tick.blocked) } })
  }
  if (previous && tick.targetsInService > previous.targetsInService) {
    cues.push({ at: 0.05, cue: { sound: 'connected', volume: 0.7 } })
  }
  if (tick.alarm !== 'ok' && tick.alarm !== previous?.alarm) {
    cues.push({ at: 0.85, cue: { sound: 'alarm-bell', volume: 0.8 } })
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
