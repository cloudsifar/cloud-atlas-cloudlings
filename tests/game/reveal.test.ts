// When the kites land, the objectives tick one at a time, a second apart, in the level's
// order; the results card waits for the endings and for every tick (ADRs 0009 and 0011).

import { describe, expect, it } from 'vitest'
import {
  OBJECTIVE_TICK_MS,
  RESULTS_DELAY_MS,
  objectiveTickTimes,
  objectivesTickedBy,
  resultsDelay,
} from '../../src/game/reveal'
import { LEVELS } from '../../src/levels'

describe('objectiveTickTimes', () => {
  it('ticks the first objective on landing and each later one a second after the last', () => {
    expect(OBJECTIVE_TICK_MS).toBe(1000)
    expect(objectiveTickTimes(3)).toEqual([0, 1000, 2000])
  })

  it('has nothing to tick for a level with no objectives', () => {
    expect(objectiveTickTimes(0)).toEqual([])
  })
})

describe('objectivesTickedBy', () => {
  it('counts the objectives that have ticked so far', () => {
    expect(objectivesTickedBy(0, 3)).toBe(1)
    expect(objectivesTickedBy(999, 3)).toBe(1)
    expect(objectivesTickedBy(1000, 3)).toBe(2)
    expect(objectivesTickedBy(5000, 3)).toBe(3)
  })
})

describe('resultsDelay', () => {
  it('waits three seconds when the objectives have all ticked by then', () => {
    expect(RESULTS_DELAY_MS).toBe(3000)
    expect(resultsDelay(1)).toBe(3000)
    expect(resultsDelay(3)).toBe(3000)
  })

  it('waits one tick past the last objective when there are more of them', () => {
    expect(resultsDelay(5)).toBe(5000)
  })

  it('never opens the results before the last objective of any shipped level has ticked', () => {
    for (const level of LEVELS) {
      const ticks = objectiveTickTimes(level.objectives.length)
      expect(resultsDelay(level.objectives.length)).toBeGreaterThan(Math.max(...ticks))
    }
  })
})
