// The engine's public surface. Other layers import from here, never from the
// individual rule modules, so the engine can be reorganised without touching them.

export * from './model'
export * from './trace'
export { PORT_OPTIONS, describePort, portOptionCovers, HTTP_PORT, HTTPS_PORT } from './ports'
export { cidrContains, addressInSubnet } from './address'
export { evaluateFlow, healthyTargets } from './flow'
export {
  expandAutoScalingGroups,
  groupInstances,
  groupInstanceId,
  runningCount,
} from './autoScaling'
export {
  simulateCrowd,
  deliveredShare,
  REQUESTS_PER_TICK,
  LAUNCH_TICKS,
  SCALE_IN_TICKS,
  type AlarmState,
  type CrowdRecord,
  type TickRecord,
} from './crowd'
export {
  crowdTimeline,
  surgeKitesAt,
  surgeWindow,
  waveCrowdAt,
  type Crowd,
  type CrowdMoment,
  type CrowdSurge,
  type CrowdWave,
  type ScenarioEvent,
} from './timeline'
export { resolveRoute, isPublicSubnet, type RouteDecision, type RouteQuery } from './routing'
export { evaluateSecurityGroups, type ConnectionPeer } from './securityGroups'
export { evaluateNetworkAcl } from './networkAcls'
export { evaluateIdentityPolicy } from './iam'
export { evaluateBucketAccess, isBucketPublic, hasPublicStatement, type Caller } from './s3'
export { validateScene, type SceneProblem } from './validate'
export {
  evaluateObjectives,
  evaluatePredicate,
  type FlowRun,
  type FlowSelector,
  type Objective,
  type ObjectiveResult,
  type Predicate,
} from './predicates'
export { scoreScene, type Finding } from './scoring'
export { costOfScene, coinsFor, type CostLine, type SceneCost } from './cost'
