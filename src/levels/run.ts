// runLevel: fly every kite in a level against a scene and score the result.
// Pure: the same level and scene always give the same LevelRun.

import {
  evaluateFlow,
  evaluateObjectives,
  evaluatePredicate,
  scoreScene,
  type Finding,
  type Flow,
  type FlowResult,
  type ObjectiveResult,
  type Scene,
} from '../engine'
import type { Kite, Level } from './schema'

export type KiteRun = { kite: Kite; flow: Flow; result: FlowResult }

export type Stars = {
  /** ★ It works: every objective met. */
  works: boolean
  /** ★ Least privilege: nothing opens more than the level needs. */
  leastPrivilege: boolean
  /** ★ Well architected: the level's own criterion. */
  wellArchitected: boolean
}

export type LevelRun = {
  kiteRuns: KiteRun[]
  objectives: ObjectiveResult[]
  /** What stands between the player and the least-privilege star. */
  findings: Finding[]
  stars: Stars
  starCount: number
}

/** `sequence` is the kite's place in the run; the load balancer uses it to take turns. */
export function kiteToFlow(kite: Kite, sequence: number): Flow {
  return {
    id: kite.id,
    source: { kind: 'internet', ip: kite.ip },
    destination: { kind: 'resource', id: kite.destinationId },
    port: kite.port,
    payload: kite.payload,
    intent: kite.kind === 'hostile' ? 'hostile' : 'legitimate',
    action: kite.action,
    backendCall: kite.backendCall,
    sequence,
  }
}

export function runLevel(level: Level, scene: Scene): LevelRun {
  const kiteRuns = level.population.map((kite, index) => {
    const flow = kiteToFlow(kite, index)
    return { kite, flow, result: evaluateFlow(scene, flow) }
  })
  const objectives = evaluateObjectives(scene, kiteRuns, level.objectives)
  const findings = scoreScene(scene, kiteRuns, level.lockedIds)

  // The second and third stars are only meaningful on a scene that works.
  const works = objectives.every((objective) => objective.met)
  const stars: Stars = {
    works,
    leastPrivilege: works && findings.length === 0,
    wellArchitected:
      works &&
      level.stars.wellArchitected.predicates.every((predicate) =>
        evaluatePredicate(scene, kiteRuns, predicate),
      ),
  }
  return {
    kiteRuns,
    objectives,
    findings,
    stars,
    starCount: Number(stars.works) + Number(stars.leastPrivilege) + Number(stars.wellArchitected),
  }
}
