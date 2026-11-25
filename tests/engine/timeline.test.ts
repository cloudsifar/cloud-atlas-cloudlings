// The level timeline: the usual crowd and the surges and waves that change it.
//
// Crowd surges and waves are game events, not AWS behaviour, so there is no AWS page to
// cite here. What AWS does with the extra kites is tested in auto-scaling.test.ts.

import { describe, expect, it } from 'vitest'
import {
  crowdTimeline,
  surgeKitesAt,
  surgeWindow,
  waveCrowdAt,
  type Crowd,
  type CrowdSurge,
  type CrowdWave,
  type ScenarioEvent,
} from '../../src/engine'

const usual: Crowd = { loadBalancerId: 'alb', ip: '203.0.113.50', kitesPerTick: 4, ticks: 30 }
const surge: CrowdSurge = {
  kind: 'crowd-surge',
  atTick: 3,
  rampTicks: 4,
  holdTicks: 8,
  peakKitesPerTick: 40,
}
const kites = (crowd: Crowd, events: ScenarioEvent[]) =>
  crowdTimeline(crowd, events).map((moment) => moment.kites)

describe('the usual crowd', () => {
  it('has one moment per tick of the run', () => {
    expect(crowdTimeline(usual, [])).toHaveLength(30)
  })

  it('flies the usual number of kites every tick when nothing happens', () => {
    expect(kites(usual, []).every((count) => count === 4)).toBe(true)
    expect(crowdTimeline(usual, []).some((moment) => moment.surge)).toBe(false)
  })
})

describe('a crowd surge', () => {
  it('covers its climb, its peak and its fall', () => {
    expect(surgeWindow(surge)).toEqual({ first: 3, last: 3 + 4 + 8 + 4 - 1 })
  })

  it('climbs in a straight line, holds the peak, then falls back the same way', () => {
    expect(kites(usual, [surge]).slice(0, 22)).toEqual([
      4, 4, 4, 11, 18, 26, 33, 40, 40, 40, 40, 40, 40, 40, 40, 33, 26, 18, 11, 4, 4, 4,
    ])
  })

  it('marks exactly its own ticks as surge ticks', () => {
    const marked = crowdTimeline(usual, [surge]).flatMap((moment, tick) =>
      moment.surge ? [tick] : [],
    )
    const { first, last } = surgeWindow(surge)
    expect(marked).toEqual(Array.from({ length: last - first + 1 }, (_, index) => first + index))
  })

  it('jumps straight to the peak when it has no ramp', () => {
    const sudden = { ...surge, rampTicks: 0, holdTicks: 2 }
    expect(kites(usual, [sudden]).slice(2, 6)).toEqual([4, 40, 40, 4])
  })

  it('never makes the crowd smaller than usual, even with a peak below it', () => {
    const odd = { ...surge, peakKitesPerTick: 1 }
    expect(kites(usual, [odd]).every((count) => count >= 4)).toBe(true)
    expect(surgeKitesAt(odd, 4, 10)).toBe(1) // the surge alone would; the timeline does not
  })

  it('takes the bigger crowd where two surges overlap, rather than adding them', () => {
    const second = { ...surge, atTick: 5, peakKitesPerTick: 20 }
    const both = kites(usual, [surge, second])
    expect(both[10]).toBe(40)
    expect(Math.max(...both)).toBe(40)
  })

  it('is cut short by the end of the run', () => {
    const late = { ...surge, atTick: 28 }
    expect(crowdTimeline(usual, [late])).toHaveLength(30)
  })
})

describe('crowd waves', () => {
  const day: Crowd = { ...usual, ticks: 12 }
  const arrive = (atTick: number, cloudlings: number): CrowdWave => ({
    kind: 'crowd-arrives',
    atTick,
    cloudlings,
  })
  const leave = (atTick: number, cloudlings: number): CrowdWave => ({
    kind: 'crowd-leaves',
    atTick,
    cloudlings,
  })
  const waves = [arrive(2, 5), arrive(4, 10), leave(8, 10), leave(10, 5)]

  it('adds each group from its tick on and takes it away when it leaves', () => {
    expect(kites(day, waves)).toEqual([4, 4, 9, 9, 19, 19, 19, 19, 9, 9, 4, 4])
  })

  it('marks the ticks on which the crowd is bigger than usual', () => {
    expect(crowdTimeline(day, waves).map((moment) => moment.surge)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it('never takes the crowd below the usual Cloudlings', () => {
    expect(waveCrowdAt(4, [leave(0, 10)], 3)).toBe(4)
  })

  it('lets a surge lift a crowd that waves have already grown, without adding the two', () => {
    const both = kites({ ...usual, ticks: 6 }, [
      arrive(0, 6),
      { ...surge, atTick: 0, rampTicks: 0, holdTicks: 2, peakKitesPerTick: 30 },
    ])
    expect(both).toEqual([30, 30, 10, 10, 10, 10])
  })
})
