// When the kites land, the objectives tick one at a time rather than all at once (ADR 0011).
//
// The run lands only after every kite's ending has played, so the first tick coincides
// with the last animation finishing. Each later objective ticks a second after the one
// before, in the order the level file lists them, so a level's final objective ticks last.
// The results card waits until every objective has had its moment.

/** The gap between one objective ticking and the next. */
export const OBJECTIVE_TICK_MS = 1000

/**
 * How long the results card waits after landing at the least, so the rain and data have
 * time to reach the Cloudlings before the card covers the sky (ADR 0009).
 */
export const RESULTS_DELAY_MS = 3000

/** The moments, in milliseconds after landing, at which each objective ticks. */
export function objectiveTickTimes(objectiveCount: number): number[] {
  return Array.from({ length: objectiveCount }, (_, index) => index * OBJECTIVE_TICK_MS)
}

/**
 * When the results card opens, in milliseconds after landing: three seconds, or one tick
 * after the last objective if the level has so many objectives that they take longer.
 */
export function resultsDelay(objectiveCount: number): number {
  return Math.max(RESULTS_DELAY_MS, objectiveCount * OBJECTIVE_TICK_MS)
}

/** How many objectives have ticked a given number of milliseconds after landing. */
export function objectivesTickedBy(elapsedMs: number, objectiveCount: number): number {
  return objectiveTickTimes(objectiveCount).filter((at) => at <= elapsedMs).length
}
