// A level's timeline: the usual crowd, and the scripted events that change it.
//
// Time is counted in ticks, the crowd simulation's unit (see crowd.ts). The level
// file says how big the crowd usually is, how long the run lasts, and which events
// happen when; `crowdTimeline` turns that into one `CrowdMoment` per tick. The
// simulation then steps through those moments. Keeping the two apart means the
// simulation can be tested with any pattern of demand, and the events can be
// tested without simulating anything.
//
// So far there is one kind of event. A crowd surge changes who is flying, not the
// architecture, so it changes the moments rather than the scene. Events that change
// the scene, such as an Availability Zone failing, will be applied by a pure
// `applyEvent(scene, event) → scene` when they arrive (docs/adr/0005).

/** The usual crowd of friendly visitors, all sending HTTPS requests to one load balancer. */
export type Crowd = {
  loadBalancerId: string
  /** One representative address: every visitor in the crowd is treated alike. */
  ip: string
  /** Kites per tick on an ordinary day, outside any surge. */
  kitesPerTick: number
  /** How many ticks the run lasts. */
  ticks: number
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

export type ScenarioEvent = CrowdSurge

/** What happens on one tick. */
export type CrowdMoment = {
  /** Kites flown this tick. */
  kites: number
  /** True while a surge is under way (from its first tick to the end of its ramp down). */
  surge: boolean
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
 * One moment per tick of the run. Where surges overlap, the biggest crowd wins:
 * a Cloudling who turned up for one surge is the same Cloudling in the other.
 */
export function crowdTimeline(crowd: Crowd, events: ScenarioEvent[]): CrowdMoment[] {
  return Array.from({ length: crowd.ticks }, (_, tick) => {
    const surges = events.filter((event) => {
      const span = surgeWindow(event)
      return tick >= span.first && tick <= span.last
    })
    return {
      kites: Math.max(
        crowd.kitesPerTick,
        ...surges.map((surge) => surgeKitesAt(surge, crowd.kitesPerTick, tick)),
      ),
      surge: surges.length > 0,
    }
  })
}
