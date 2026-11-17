// Predicates: machine-checkable statements about a scene and a run.
//
// Levels are data, so a level cannot contain code. Instead it names predicates
// from this list. The same vocabulary serves objectives, star criteria and the
// narrator's "has the player done this yet?" checks.

import {
  findResourceOfKind,
  requireSubnet,
  type LoadBalancer,
  type PortOption,
  type RouteDestination,
  type RouteTarget,
  type Scene,
  type SecurityGroupPeer,
  type ServiceAction,
} from './model'
import { isBucketPublic } from './s3'
import { failingStep, type CheckKind, type Flow, type FlowResult } from './trace'

/** One flow and what happened to it. */
export type FlowRun = { flow: Flow; result: FlowResult }

export type FlowSelector = { intent: 'legitimate' | 'hostile' } | { flowIds: string[] }

export type Predicate =
  // --- about the run -------------------------------------------------------
  /** Every selected flow was delivered, response included. */
  | { kind: 'flows-delivered'; flows: FlowSelector }
  /** Every selected flow was stopped; with `by`, stopped by that particular control. */
  | { kind: 'flows-stopped'; flows: FlowSelector; by?: CheckKind }
  // --- about the scene -----------------------------------------------------
  | { kind: 'resource-exists'; resourceId: string }
  | {
      kind: 'route-present'
      routeTableId: string
      destination: RouteDestination
      target: RouteTarget['kind']
    }
  | {
      kind: 'security-group-allows'
      securityGroupId: string
      ports: PortOption
      peer: SecurityGroupPeer
    }
  | { kind: 'listener-is'; loadBalancerId: string; listener: LoadBalancer['listener'] }
  | { kind: 'targets-registered'; loadBalancerId: string; atLeast: number }
  | { kind: 'targets-in-both-azs'; loadBalancerId: string }
  /** Every inbound rule on every target names the load balancer's security group and nothing wider. */
  | { kind: 'targets-accept-only-load-balancer'; loadBalancerId: string }
  | { kind: 'role-attached'; instanceIds: string[] }
  | { kind: 'role-allows'; roleId: string; action: ServiceAction; resourceId: string }
  | { kind: 'bucket-not-public'; bucketId: string }

export type Objective = {
  id: string
  /** Player-facing text, e.g. "All green kites reach the load balancer". */
  text: string
  predicate: Predicate
}

export type ObjectiveResult = { id: string; text: string; met: boolean }

function selectRuns(runs: FlowRun[], selector: FlowSelector): FlowRun[] {
  return 'intent' in selector
    ? runs.filter((run) => run.flow.intent === selector.intent)
    : runs.filter((run) => selector.flowIds.includes(run.flow.id))
}

function samePeer(first: SecurityGroupPeer, second: SecurityGroupPeer): boolean {
  return JSON.stringify(first) === JSON.stringify(second)
}

export function evaluatePredicate(scene: Scene, runs: FlowRun[], predicate: Predicate): boolean {
  switch (predicate.kind) {
    case 'flows-delivered': {
      const selected = selectRuns(runs, predicate.flows)
      // "All of nothing" would be vacuously true, so an empty selection counts as not met.
      return selected.length > 0 && selected.every((run) => run.result.outcome === 'delivered')
    }
    case 'flows-stopped': {
      const selected = selectRuns(runs, predicate.flows)
      return (
        selected.length > 0 &&
        selected.every((run) => {
          const stopped = run.result.outcome === 'blocked' || run.result.outcome === 'dropped'
          return (
            stopped &&
            (predicate.by === undefined || failingStep(run.result)?.check === predicate.by)
          )
        })
      )
    }
    case 'resource-exists':
      return scene.resources.some((resource) => resource.id === predicate.resourceId)
    case 'route-present': {
      const table = scene.routeTables.find((candidate) => candidate.id === predicate.routeTableId)
      return (
        table?.routes.some(
          (route) =>
            route.destination === predicate.destination && route.target.kind === predicate.target,
        ) ?? false
      )
    }
    case 'security-group-allows': {
      const group = scene.securityGroups.find(
        (candidate) => candidate.id === predicate.securityGroupId,
      )
      return (
        group?.inbound.some(
          (rule) => rule.ports === predicate.ports && samePeer(rule.peer, predicate.peer),
        ) ?? false
      )
    }
    case 'listener-is':
      return (
        findResourceOfKind(scene, 'load-balancer', predicate.loadBalancerId)?.listener ===
        predicate.listener
      )
    case 'targets-registered': {
      const loadBalancer = findResourceOfKind(scene, 'load-balancer', predicate.loadBalancerId)
      return (loadBalancer?.targetIds.length ?? 0) >= predicate.atLeast
    }
    case 'targets-in-both-azs': {
      const loadBalancer = findResourceOfKind(scene, 'load-balancer', predicate.loadBalancerId)
      if (!loadBalancer) return false
      const zones = loadBalancer.targetIds
        .map((id) => findResourceOfKind(scene, 'ec2-instance', id))
        .filter((instance) => instance !== undefined)
        .map((instance) => requireSubnet(scene, instance.subnetId).availabilityZone)
      return new Set(zones).size >= 2
    }
    case 'targets-accept-only-load-balancer': {
      const loadBalancer = findResourceOfKind(scene, 'load-balancer', predicate.loadBalancerId)
      if (!loadBalancer || loadBalancer.targetIds.length === 0) return false
      return loadBalancer.targetIds.every((id) => {
        const instance = findResourceOfKind(scene, 'ec2-instance', id)
        if (!instance) return false
        const rules = instance.securityGroupIds.flatMap(
          (groupId) => scene.securityGroups.find((group) => group.id === groupId)?.inbound ?? [],
        )
        return rules.every(
          (rule) =>
            rule.peer.kind === 'security-group' &&
            loadBalancer.securityGroupIds.includes(rule.peer.securityGroupId),
        )
      })
    }
    case 'role-attached':
      return predicate.instanceIds.every((id) => {
        const instance = findResourceOfKind(scene, 'ec2-instance', id)
        return (
          instance !== undefined &&
          instance.roleId !== null &&
          findResourceOfKind(scene, 'iam-role', instance.roleId) !== undefined
        )
      })
    case 'role-allows': {
      const role = findResourceOfKind(scene, 'iam-role', predicate.roleId)
      return (
        role?.statements.some(
          (statement) =>
            statement.effect === 'allow' &&
            statement.actions.includes(predicate.action) &&
            (statement.resource === predicate.resourceId || statement.resource === '*'),
        ) ?? false
      )
    }
    case 'bucket-not-public': {
      const bucket = findResourceOfKind(scene, 's3-bucket', predicate.bucketId)
      return bucket !== undefined && !isBucketPublic(bucket)
    }
  }
}

export function evaluateObjectives(
  scene: Scene,
  runs: FlowRun[],
  objectives: Objective[],
): ObjectiveResult[] {
  return objectives.map((objective) => ({
    id: objective.id,
    text: objective.text,
    met: evaluatePredicate(scene, runs, objective.predicate),
  }))
}
