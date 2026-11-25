// Storm Front playback: how the engine's record of an Availability Zone failure is placed
// on the clock, the sky and the ground (ADR 0014).
//
// Nothing here is AWS behaviour (that is tested in tests/engine/storm.test.ts); these
// tests pin what the player sees and when, including the pacing Simon asked for after
// Level 5: "allow enough time between events so that the user can process what is
// happening and understand it. The level is not a race."

import { describe, expect, it } from 'vitest'
import {
  crowdClock,
  crowdCuesBetween,
  crowdLog,
  crowdRealDuration,
  crowdRunDuration,
  crowdSpots,
  crowdStream,
  databaseViewAt,
  fleetMembers,
  fleetViewAt,
  heldMinutes,
  HELD_MINUTE_DURATION,
  outageAt,
  playedTicks,
  SETTLED_TICKS,
  settledFrom,
  TICK_DURATION,
} from '../../src/game/crowdPlayback'
import { layoutScene } from '../../src/game/layout'
import { SILHOUETTES } from '../../src/game/placeholderArt'
import { LEVELS, runLevel } from '../../src/levels'

const level = LEVELS.find((candidate) => candidate.id === 6)!
const crowdDay = LEVELS.find((candidate) => candidate.id === 5)!
const solved = runLevel(level, level.referenceSolution).crowd!
const unsolved = runLevel(level, level.initialScene).crowd!
const STRIKE = level.events.find((event) => event.kind === 'az-failure')!.atTick
const at = (minute: number, fraction = 0) => (minute + fraction) * TICK_DURATION

describe('the pace of Storm Front', () => {
  it('lets the day settle before the storm: several calm minutes first', () => {
    expect(STRIKE * TICK_DURATION).toBeGreaterThanOrEqual(8000)
    expect(solved.ticks.slice(0, STRIKE).every((tick) => tick.delivered === tick.demand)).toBe(true)
  })

  it('plays the storm’s minutes slower: the strike, the failover and the replacements', () => {
    const held = heldMinutes(solved)
    expect(held).toContain(STRIKE)
    expect(held).toEqual([STRIKE, STRIKE + 1, STRIKE + 2, STRIKE + 3])
    expect(HELD_MINUTE_DURATION).toBeGreaterThanOrEqual(3 * TICK_DURATION)
    // From the strike to the replacements serving takes at least ten seconds on screen.
    expect(held.length * HELD_MINUTE_DURATION).toBeGreaterThanOrEqual(10000)
  })

  it('holds nothing on a day without a storm or a database: Crowd Day keeps its pace', () => {
    const crowd = runLevel(crowdDay, crowdDay.referenceSolution).crowd!
    expect(heldMinutes(crowd)).toEqual([])
    expect(crowdClock(crowd, 12345)).toBe(12345)
    expect(crowdRealDuration(crowd)).toBe(crowdRunDuration(crowd))
  })

  it('has a clock that only moves forward and ends the run when the crowd’s time is up', () => {
    let last = -1
    for (let elapsed = 0; elapsed <= crowdRealDuration(solved); elapsed += 97) {
      const time = crowdClock(solved, elapsed)
      expect(time).toBeGreaterThan(last)
      last = time
    }
    expect(crowdClock(solved, crowdRealDuration(solved))).toBeCloseTo(crowdRunDuration(solved), 6)
    // Nothing is held before the strike, so the strike starts on time; its minute
    // then takes HELD_MINUTE_DURATION to pass.
    const strike = STRIKE * TICK_DURATION
    expect(crowdClock(solved, strike)).toBeCloseTo(strike, 6)
    expect(crowdClock(solved, strike + HELD_MINUTE_DURATION)).toBeCloseTo(strike + TICK_DURATION, 6)
  })
})

describe('a day that has settled ends early', () => {
  // Simon, 25 November 2026: "after the kites drop to the ground the simulation is over
  // anyway and the next button should appear".

  it('stops the unsolved storm a couple of minutes after the kites fall', () => {
    const from = settledFrom(unsolved)!
    expect(from).toBe(STRIKE)
    expect(playedTicks(unsolved)).toBe(STRIKE + 1 + SETTLED_TICKS)
    expect(crowdRunDuration(unsolved)).toBeLessThan(unsolved.ticks.length * TICK_DURATION)
    expect(crowdClock(unsolved, crowdRealDuration(unsolved))).toBeCloseTo(
      crowdRunDuration(unsolved),
      6,
    )
  })

  it('cuts only minutes in which nothing is answered and nothing changes', () => {
    const tail = unsolved.ticks.slice(settledFrom(unsolved)!)
    expect(tail.every((tick) => tick.delivered === 0 && tick.demand > 0)).toBe(true)
    const states = new Set(
      tail.map((tick) =>
        JSON.stringify({ ...tick, tick: 0, served: null, stopped: null, timedOut: null }),
      ),
    )
    expect(states.size).toBe(1)
  })

  it('plays the whole day when anything is still answered or still changing', () => {
    expect(settledFrom(solved)).toBeNull()
    expect(playedTicks(solved)).toBe(solved.ticks.length)
    for (const scene of [crowdDay.initialScene, crowdDay.referenceSolution]) {
      const crowd = runLevel(crowdDay, scene).crowd!
      expect(playedTicks(crowd)).toBe(crowd.ticks.length)
    }
  })

  it('still judges the objectives on the whole day', () => {
    const run = runLevel(level, level.initialScene)
    expect(run.crowd!.ticks).toHaveLength(level.crowd!.ticks)
  })
})

describe('the ground: eight Cloudlings, spaced out', () => {
  const peak = Math.max(...solved.ticks.map((tick) => tick.demand))
  const spots = crowdSpots(level.population, peak).slice(0, peak)

  it('puts the newcomers in the gaps between the regulars, all in one row', () => {
    expect(spots).toHaveLength(8)
    const xs = spots.map((spot) => spot.x).sort((first, second) => first - second)
    const gaps = xs.slice(1).map((x, index) => x - xs[index]!)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(50)
    expect(new Set(spots.map((spot) => spot.y)).size).toBe(1)
  })

  it('keeps the regulars where they stand', () => {
    expect(spots.slice(0, level.population.length)).toEqual(
      crowdSpots(level.population).slice(0, level.population.length),
    )
  })

  it('leaves a big crowd as it was: Crowd Day’s places do not change', () => {
    const big = Math.max(
      ...runLevel(crowdDay, crowdDay.referenceSolution).crowd!.ticks.map((tick) => tick.demand),
    )
    expect(crowdSpots(crowdDay.population, big)).toEqual(crowdSpots(crowdDay.population))
  })
})

describe('the sky in the storm', () => {
  it('shows the outage from the strike to the end, with a strike at the start', () => {
    expect(outageAt(solved, at(STRIKE - 1, 0.5)).zones).toEqual([])
    const strike = outageAt(solved, at(STRIKE, 0.05))
    expect(strike.zones).toEqual(['a'])
    expect(strike.struck).toEqual(['a'])
    expect(outageAt(solved, at(STRIKE + 5)).zones).toEqual(['a'])
    expect(outageAt(solved, at(STRIKE + 5)).struck).toEqual([])
  })

  it('shows the Multi-AZ database failing over, then answering from AZ b', () => {
    expect(databaseViewAt(solved, 'db', at(STRIKE - 1))?.primaryZone).toBe('a')
    expect(databaseViewAt(solved, 'db', at(STRIKE, 0.5))?.status).toBe('failing-over')
    const after = databaseViewAt(solved, 'db', at(STRIKE + 3))
    expect(after?.status).toBe('available')
    expect(after?.primaryZone).toBe('b')
    expect(after?.lostZone).toBe('a')
  })

  it('shows the single-AZ database down with its zone', () => {
    expect(databaseViewAt(unsolved, 'db', at(STRIKE + 3))?.status).toBe('unavailable')
  })

  it('greys the fleet’s instances in AZ a, then shows replacements in AZ b', () => {
    const struck = fleetViewAt(solved, 'asg', at(STRIKE, 0.9))!
    expect(struck.zones.a.failed).toBe(2)
    expect(struck.zones.b.serving).toBe(2)
    const replaced = fleetViewAt(solved, 'asg', at(STRIKE + 4))!
    expect(replaced.zones.a.serving + replaced.zones.a.failed).toBe(0)
    expect(replaced.zones.b.serving).toBe(4)
  })

  it('draws one cloudlet per instance: four instances, four clouds', () => {
    // Simon, 25 November 2026: "It should be a direct correlation visually 4=4 objects".
    expect(SILHOUETTES.cloudlet).toHaveLength(1) // one outlined shape per instance
    for (let minute = 0; minute < solved.ticks.length; minute += 0.5) {
      const view = fleetViewAt(solved, 'asg', at(minute))!
      for (const zone of ['a', 'b'] as const) {
        const counts = view.zones[zone]
        expect(fleetMembers(counts)).toHaveLength(counts.serving + counts.failed + counts.launching)
      }
    }
    const calm = fleetViewAt(solved, 'asg', at(STRIKE - 2))!
    expect(fleetMembers(calm.zones.a)).toEqual(['serving', 'serving'])
    expect(fleetMembers(calm.zones.b)).toEqual(['serving', 'serving'])
    const struck = fleetViewAt(solved, 'asg', at(STRIKE + 1, 0.9))!
    expect(fleetMembers(struck.zones.b)).toEqual(['serving', 'serving', 'launching', 'launching'])
  })

  it('marks where the storm’s kites go unanswered when nothing healthy is left', () => {
    const scene = level.initialScene
    const stream = crowdStream(unsolved.ticks[STRIKE + 1]!, scene, layoutScene(scene), {
      x: 500,
      y: 600,
    })
    expect(stream.stoppedAt).not.toBeNull()
    expect(stream.stoppedLabel).toBe('✕ nothing answers here')
  })

  it('during the failover, kites go all the way in, and the database is marked as not answering', () => {
    const scene = level.referenceSolution
    const stream = crowdStream(solved.ticks[STRIKE]!, scene, layoutScene(scene), { x: 500, y: 600 })
    expect(stream.stoppedAt).toBeNull()
    expect(stream.branches.length).toBeGreaterThan(0)
    expect(stream.branches.every((branch) => branch.outcome === 'dropped')).toBe(true)
    expect(stream.databaseNote?.label).toBe('✕ no answer while it fails over')
  })

  it('thunders at the strike', () => {
    const sounds = crowdCuesBetween(solved, at(STRIKE) - 1, at(STRIKE, 0.5)).map((cue) => cue.sound)
    expect(sounds).toContain('thunder')
  })
})

describe('the CloudWatch log in the storm', () => {
  const names = { asg: 'web fleet', db: 'orders database' }

  it('says when the zone failed, what the database did and when replacements served', () => {
    const entries = crowdLog(solved, null, names)
    const storm = entries.find((entry) => entry.kind === 'storm')
    expect(storm?.minute).toBe(STRIKE)
    expect(entries.some((entry) => entry.kind === 'database' && entry.minute === STRIKE)).toBe(true)
    expect(entries.some((entry) => entry.kind === 'database' && entry.minute === STRIKE + 2)).toBe(
      true,
    )
  })

  it('says, for the unsolved sky, that nothing healthy was left', () => {
    const entries = crowdLog(unsolved, null, names)
    expect(entries.some((entry) => /no healthy targets/i.test(entry.text))).toBe(true)
  })
})
