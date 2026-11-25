// A level's timeline: the usual crowd, and the scripted events that change it.
//
// Time is counted in ticks, the crowd simulation's unit (see crowd.ts). The level
// file says how big the crowd usually is, how long the run lasts, and which events
// happen when; `crowdTimeline` turns that into one `CrowdMoment` per tick. The
// simulation then steps through those moments. Keeping the two apart means the
// simulation can be tested with any pattern of demand, and the events can be
// tested without simulating anything.
//
// Three kinds of event so far. Two are about who is flying: a crowd surge (a smooth
// climb to a peak and back) and crowd waves (groups of Cloudlings who arrive, stay and
// later leave). The third, an Availability Zone failing, is about the sky: each
// moment says which zones are down, and the crowd simulation applies that to the scene
// on each tick (crowd.ts, ADR 0014). None of them changes the scene itself.

import type { AvailabilityZone } from './model'
import type { BackendCall } from './trace'

/** The usual crowd of friendly visitors, all sending HTTPS requests to one load balancer. */
export type Crowd = {
  loadBalancerId: string
  /** One representative address: every visitor in the crowd is treated alike. */
  ip: string
  /**
   * The usual crowd: how many Cloudlings are there on an ordinary day, outside any
   * surge or wave. Each keeps one kite up, so this is also the kites flown per tick.
   */
  kitesPerTick: number
  /** How many ticks the run lasts. */
  ticks: number
  /**
   * Work the application does for each request before it can answer, e.g. reading
   * from its database (ADR 0014). The same call a kite's `backendCall` makes.
   */
  backendCall?: BackendCall
}

/** For a while, many more Cloudlings than usual turn up, then drift away again. */
export type CrowdSurge = {
  kind: 'crowd-surge'
  /** The first tick on which the crowd is bigger than usual. */
  atTick: number
  /** Ticks spent growing towards the peak. Shrinking back takes as long again. */
  rampTicks: number
  /** Ticks spent at the peak. */
  holdTicks: number
  /** Kites per tick at the peak. */
  peakKitesPerTick: number
}

/**
 * Some Cloudlings walk on and stay, each keeping one kite up, until a later wave takes
 * them home (ADR 0012). Waves add to and take from the usual crowd: the crowd at any
 * tick is the usual crowd, plus everyone who has arrived, minus everyone who has left.
 */
export type CrowdWave = {
  kind: 'crowd-arrives' | 'crowd-leaves'
  /** The first tick on which the change is felt. */
  atTick: number
  /** How many Cloudlings arrive or leave. */
  cloudlings: number
}

/**
 * An Availability Zone fails from `atTick` until the end of the run (ADR 0014).
 * Everything in it becomes unhealthy: instances, a load balancer's node there, a NAT
 * Gateway, and a database whose primary runs there. The scene is not changed; the
 * crowd simulation applies the outage tick by tick (crowd.ts).
 */
export type AzFailure = {
  kind: 'az-failure'
  atTick: number
  zone: AvailabilityZone
}

export type ScenarioEvent = CrowdSurge | CrowdWave | AzFailure

/** What happens on one tick. */
export type CrowdMoment = {
  /** Kites flown this tick: one for each Cloudling in the crowd. */
  kites: number
  /**
   * True while the crowd is bigger than usual: while a surge is under way (from its
   * first tick to the end of its ramp down), or while waves have added Cloudlings.
   */
  surge: boolean
  /** Availability Zones that are down on this tick. Absent means none. */
  failedZones?: AvailabilityZone[]
}

/** The ticks a surge covers, first to last inclusive. */
export function surgeWindow(surge: CrowdSurge): { first: number; last: number } {
  return { first: surge.atTick, last: surge.atTick + 2 * surge.rampTicks + surge.holdTicks - 1 }
}

/**
 * Kites per tick during one surge: a straight-line climb from the usual crowd to the
 * peak, a steady stretch at the peak, then a straight-line fall back. Outside the
 * surge, the usual crowd.
 */
export function surgeKitesAt(surge: CrowdSurge, usual: number, tick: number): number {
  const step = tick - surge.atTick
  const rise = surge.peakKitesPerTick - usual
  const ramp = surge.rampTicks
  if (step < 0) return usual
  if (step < ramp) return usual + Math.round((rise * (step + 1)) / (ramp + 1))
  if (step < ramp + surge.holdTicks) return surge.peakKitesPerTick
  const fallen = step - ramp - surge.holdTicks
  if (fallen < ramp) return usual + Math.round((rise * (ramp - fallen)) / (ramp + 1))
  return usual
}

/**
 * The crowd's size at a tick from its waves alone: the usual crowd, plus everyone who
 * has arrived by then, minus everyone who has left. Never below the usual crowd.
 */
export function waveCrowdAt(usual: number, events: ScenarioEvent[], tick: number): number {
  let size = usual
  for (const event of events) {
    if (event.kind === 'crowd-surge' || event.kind === 'az-failure' || event.atTick > tick) continue
    size += event.kind === 'crowd-arrives' ? event.cloudlings : -event.cloudlings
  }
  return Math.max(usual, size)
}

/** The Availability Zones that are down at a tick: every zone that has failed by then. */
export function failedZonesAt(events: ScenarioEvent[], tick: number): AvailabilityZone[] {
  const zones = events
    .filter((event): event is AzFailure => event.kind === 'az-failure' && event.atTick <= tick)
    .map((event) => event.zone)
  return [...new Set(zones)].sort()
}

/**
 * One moment per tick of the run. Waves set the crowd; a surge can lift it higher.
 * Where surges overlap, the biggest crowd wins: a Cloudling who turned up for one
 * surge is the same Cloudling in the other.
 */
export function crowdTimeline(crowd: Crowd, events: ScenarioEvent[]): CrowdMoment[] {
  const surges = events.filter((event): event is CrowdSurge => event.kind === 'crowd-surge')
  return Array.from({ length: crowd.ticks }, (_, tick) => {
    const active = surges.filter((surge) => {
      const span = surgeWindow(surge)
      return tick >= span.first && tick <= span.last
    })
    const waves = waveCrowdAt(crowd.kitesPerTick, events, tick)
    const failedZones = failedZonesAt(events, tick)
    return {
      kites: Math.max(
        waves,
        ...active.map((surge) => surgeKitesAt(surge, crowd.kitesPerTick, tick)),
      ),
      surge: active.length > 0 || waves > crowd.kitesPerTick,
      ...(failedZones.length > 0 ? { failedZones } : {}),
    }
  })
}
