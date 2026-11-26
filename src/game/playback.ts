// Playback: turns the engine's traces into a timetable for the animation.
//
// Nothing here decides what happens to a kite; the engine already did. This file
// only answers "where is each kite at time t?", as a pure function of the trace,
// so the same run always plays the same way and reduced-motion mode can simply
// ask for the final frame.

import { failingStep, type CheckKind, type Scene, type TraceStep } from '../engine'
import type { KiteRun, LevelRun } from '../levels'
import {
  borderCrossing,
  cloudlingPosition,
  kiteRestPosition,
  positionOfRef,
  type Point,
  type SceneLayout,
} from './layout'
import type { SoundId } from './sound'

/** One trace step, placed on the stage and on the clock. */
export type Beat = {
  step: TraceStep
  position: Point
  /**
   * A place passed on the way to this beat that has no check of its own: a reply
   * crossing a subnet passes back through the load balancer between the subnet's two
   * checks (in, then out).
   */
  via?: Point
  /** The request travels as a kite; backend calls and responses travel as rain. */
  carrier: 'kite' | 'rain'
  /** Milliseconds after the kite's own start at which the carrier sets off for, and reaches, this beat. */
  departAt: number
  arriveAt: number
}

export type Ending =
  | 'delivered' // green kite got through: burst, rain on the Cloudling, a cheer
  | 'foiled' // red kite stopped: a success, and it must look like one
  | 'failed' // green kite stopped: the player's misconfiguration
  | 'breach' // red kite got in

export type KiteScript = {
  kiteRun: KiteRun
  cloudling: Point
  rest: Point
  /** When this kite launches, in milliseconds from the start of the run. */
  startAt: number
  beats: Beat[]
  ending: Ending
  /** The control that stopped the kite, if one did. */
  stoppedBy?: CheckKind
  /** Local time at which the ending animation begins, and how long the whole script lasts. */
  endingAt: number
  duration: number
  /** Sounds to play, at local times. */
  cues: { at: number; sound: SoundId }[]
}

const SPEED = 0.45 // stage pixels per millisecond
const PAUSE_AT_CHECK = 230
const LAUNCH_INTERVAL = 700
export const ENDING_DURATION = 1400

const BLOCK_SOUND: Record<CheckKind, SoundId> = {
  'security-group': 'blocked-security-group',
  nacl: 'blocked-nacl',
  route: 'no-route',
  iam: 'blocked-iam',
  'bucket-policy': 'blocked-iam',
  'block-public-access': 'blocked-public-access',
  listener: 'timed-out',
  waf: 'blocked-waf',
  'target-selection': 'timed-out',
  delivery: 'timed-out',
  capacity: 'timed-out',
}

function endingOf(kiteRun: KiteRun): Ending {
  const hostile = kiteRun.kite.kind === 'hostile'
  switch (kiteRun.result.outcome) {
    case 'delivered':
      return hostile ? 'breach' : 'delivered'
    case 'breach':
      return 'breach'
    case 'blocked':
    case 'dropped':
      return hostile ? 'foiled' : 'failed'
  }
}

export function buildScript(
  kiteRun: KiteRun,
  scene: Scene,
  layout: SceneLayout,
  launchIndex: number,
): KiteScript {
  const cloudling = cloudlingPosition(kiteRun.kite.groundPosition)
  const rest = kiteRestPosition(kiteRun.kite.groundPosition)
  const steps = [...kiteRun.result.trace, ...(kiteRun.result.responseTrace ?? [])]
  const failed = failingStep(kiteRun.result)
  // Nothing is animated after the step that stopped the flow.
  const shown = failed ? steps.slice(0, steps.indexOf(failed) + 1) : steps

  const places = placeSteps(steps, scene, layout, cloudling, rest)
  const beats: Beat[] = []
  let clock = 0
  let previous = rest
  shown.forEach((step, index) => {
    const { position, via } = places[index] ?? { position: previous }
    const distance = pathLength(via ? [previous, via, position] : [previous, position])
    const departAt = clock
    const arriveAt = departAt + distance / SPEED
    beats.push({
      step,
      position,
      ...(via ? { via } : {}),
      carrier: step.leg === 'request' ? 'kite' : 'rain',
      departAt,
      arriveAt,
    })
    clock = arriveAt + PAUSE_AT_CHECK
    previous = position
  })

  const ending = endingOf(kiteRun)
  const cues: KiteScript['cues'] = []
  for (const beat of beats) {
    if (beat.step.check === 'target-selection' && beat.step.result === 'pass') {
      cues.push({ at: beat.arriveAt, sound: 'forwarded' })
    }
  }
  const firstRain = beats.find((beat) => beat.carrier === 'rain')
  if (firstRain) cues.push({ at: firstRain.departAt, sound: 'rain' })
  if (ending === 'delivered') {
    cues.push({ at: clock, sound: 'delivered' }, { at: clock + 250, sound: 'cheer' })
  } else if (ending === 'breach') {
    cues.push({ at: clock, sound: 'breach' })
  } else {
    if (failed) cues.push({ at: clock - PAUSE_AT_CHECK, sound: BLOCK_SOUND[failed.check] })
    cues.push({
      at: clock + 350,
      sound: ending === 'foiled' ? 'hostile-foiled' : 'friendly-failed',
    })
  }

  return {
    kiteRun,
    cloudling,
    rest,
    startAt: launchIndex * LAUNCH_INTERVAL,
    beats,
    ending,
    stoppedBy: failed?.check,
    endingAt: clock,
    duration: clock + ENDING_DURATION,
    cues,
  }
}

/**
 * A kite or its reply crossing a subnet's fence: a network ACL check on the main path.
 * Backend calls keep their simpler placement (the nearest stretch of fence), since the
 * NAT gateway or endpoint they pass has no step of its own to steer by.
 */
const isCrossing = (step: TraceStep | undefined): boolean =>
  step?.at.kind === 'subnet' &&
  step.check === 'nacl' &&
  (step.leg === 'request' || step.leg === 'response')

/** Two crossings of one subnet in a row: in, then straight back out. */
const sameSubnet = (first: TraceStep | undefined, second: TraceStep | undefined): boolean =>
  isCrossing(first) &&
  isCrossing(second) &&
  first?.at.kind === 'subnet' &&
  second?.at.kind === 'subnet' &&
  first.at.id === second.at.id

/**
 * Places every step of a trace on the stage. Resources are their cloud's centre; a
 * subnet's check is the point where the path crosses that subnet's fence, going in
 * towards the resource the flow visits there or coming out towards wherever it goes
 * next. Whether a check is going in or coming out follows the path: the flow is inside
 * a subnet from the check that lets it in (or from a resource it starts at there) until
 * the check that lets it out. A reply's two checks at one subnet (in, then out) pass
 * through the resource the request visited there, which has no check on the way back.
 */
export function placeSteps(
  steps: TraceStep[],
  scene: Scene,
  layout: SceneLayout,
  cloudling: Point,
  rest: Point,
): { position: Point; via?: Point }[] {
  const centre = (step: TraceStep, previous: Point) =>
    positionOfRef(scene, layout, step.at, cloudling, previous)
  const subnetOf = (step: TraceStep): string | undefined => {
    if (step.at.kind !== 'resource') return undefined
    const id = step.at.id.split('#')[0]
    const resource = scene.resources.find((each) => each.id === id)
    return resource && 'subnetId' in resource ? resource.subnetId : undefined
  }
  // The resource the request visits inside each subnet: the one right after the check
  // that lets it in.
  const visited = new Map<string, Point>()
  steps.forEach((step, index) => {
    const next = steps[index + 1]
    if (
      step.leg === 'request' &&
      isCrossing(step) &&
      step.at.kind === 'subnet' &&
      next?.at.kind === 'resource' &&
      !visited.has(step.at.id)
    )
      visited.set(step.at.id, centre(next, rest))
  })
  // Where the flow is going after a step on the main path: the next resource, the
  // resource inside the next subnet it passes straight through, or (on the way back)
  // its Cloudling.
  const headingFor = (index: number): Point | undefined => {
    const step = steps[index] as TraceStep
    if (step.at.kind === 'subnet' && sameSubnet(step, steps[index + 1])) {
      const inside = visited.get(step.at.id)
      if (inside) return inside
    }
    for (let next = index + 1; next < steps.length; next++) {
      const later = steps[next] as TraceStep
      if (later.leg !== step.leg) break
      if (later.at.kind !== 'subnet') return centre(later, rest)
      const inside = visited.get(later.at.id)
      if (sameSubnet(later, steps[next + 1]) && inside) return inside
    }
    return step.leg === 'response' ? { x: cloudling.x, y: cloudling.y - 60 } : undefined
  }

  const places: { position: Point; via?: Point }[] = []
  let previous = rest
  let inside: string | undefined
  steps.forEach((step, index) => {
    let place: { position: Point; via?: Point } = { position: centre(step, previous) }
    const home = subnetOf(step)
    if (home) inside = home
    const rect = step.at.kind === 'subnet' ? layout.subnets[step.at.id] : undefined
    if (isCrossing(step) && step.at.kind === 'subnet' && rect) {
      const entering = inside !== step.at.id
      inside = entering ? step.at.id : undefined
      const via = sameSubnet(steps[index - 1], step) ? visited.get(step.at.id) : undefined
      const from = via ?? previous
      const heading = headingFor(index)
      place = {
        position: heading
          ? borderCrossing(rect, from, heading, entering ? 'enter' : 'exit')
          : borderCrossing(rect, from, from, 'enter'),
        ...(via ? { via } : {}),
      }
    }
    places.push(place)
    previous = place.position
  })
  return places
}

function pathLength(points: Point[]): number {
  let length = 0
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] as Point
    const to = points[index] as Point
    length += Math.hypot(to.x - from.x, to.y - from.y)
  }
  return length
}

/** The point a fraction of the way along a path of straight pieces. */
function alongPath(points: Point[], fraction: number): Point {
  const total = pathLength(points)
  let remaining = total * fraction
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] as Point
    const to = points[index] as Point
    const piece = Math.hypot(to.x - from.x, to.y - from.y)
    if (remaining <= piece || index === points.length - 1) {
      const part = piece === 0 ? 1 : Math.min(1, remaining / piece)
      return { x: from.x + (to.x - from.x) * part, y: from.y + (to.y - from.y) * part }
    }
    remaining -= piece
  }
  return points[points.length - 1] ?? { x: 0, y: 0 }
}

export function buildScripts(run: LevelRun, scene: Scene, layout: SceneLayout): KiteScript[] {
  return run.kiteRuns.map((kiteRun, index) => buildScript(kiteRun, scene, layout, index))
}

export function runDuration(scripts: KiteScript[]): number {
  return Math.max(0, ...scripts.map((script) => script.startAt + script.duration))
}

export type KiteFrame = {
  phase: 'waiting' | 'flying' | 'ending' | 'done'
  /** Where the carrier (kite or rain) is. */
  position: Point
  carrier: 'kite' | 'rain'
  /** Index of the last beat reached, or -1. Beats up to here show their markers. */
  reached: number
  /** 0 to 1 through the ending animation. */
  endingProgress: number
  /** Where the kite itself is while rain is travelling: the last place it reached. */
  kitePosition: Point
}

/** Where is this kite at `time` (milliseconds since the run began)? */
export function frameAt(script: KiteScript, time: number): KiteFrame {
  const local = time - script.startAt
  const lastKiteBeat = [...script.beats].reverse().find((beat) => beat.carrier === 'kite')
  const kiteHome = lastKiteBeat?.position ?? script.rest

  if (local < 0) {
    return {
      phase: 'waiting',
      position: script.rest,
      carrier: 'kite',
      reached: -1,
      endingProgress: 0,
      kitePosition: script.rest,
    }
  }
  if (local >= script.endingAt) {
    const last = script.beats[script.beats.length - 1]
    const endingProgress = Math.min(1, (local - script.endingAt) / ENDING_DURATION)
    return {
      phase: endingProgress >= 1 ? 'done' : 'ending',
      position: last?.position ?? script.rest,
      carrier: last?.carrier ?? 'kite',
      reached: script.beats.length - 1,
      endingProgress,
      kitePosition: kiteHome,
    }
  }

  // Flying: find the beat the carrier is heading for (or pausing at).
  const index = script.beats.findIndex((beat) => local < beat.arriveAt + PAUSE_AT_CHECK)
  const beat = script.beats[index]
  if (!beat) throw new Error('unreachable: local time is before endingAt')
  const from = script.beats[index - 1]?.position ?? script.rest
  const travel = beat.arriveAt - beat.departAt
  const fraction = travel <= 0 ? 1 : Math.min(1, Math.max(0, (local - beat.departAt) / travel))
  const position = alongPath(
    beat.via ? [from, beat.via, beat.position] : [from, beat.position],
    fraction,
  )
  const arrived = local >= beat.arriveAt
  return {
    phase: 'flying',
    position,
    carrier: beat.carrier,
    reached: arrived ? index : index - 1,
    endingProgress: 0,
    kitePosition: beat.carrier === 'kite' ? position : kiteHome,
  }
}

/** The sounds whose moment falls in the half-open interval (from, to]. */
export function soundsBetween(scripts: KiteScript[], from: number, to: number): SoundId[] {
  return scripts.flatMap((script) =>
    script.cues
      .filter((cue) => script.startAt + cue.at > from && script.startAt + cue.at <= to)
      .map((cue) => cue.sound),
  )
}
