// Predicates: machine-checkable statements about a scene and a run.
//
// Levels are data, so a level cannot contain code. Instead it names predicates
// from this list. The same vocabulary serves objectives, star criteria and the
// narrator's "has the player done this yet?" checks.

import { expandAutoScalingGroups } from './autoScaling'
import { costOfScene } from './cost'
import { deliveredShare, type CrowdRecord } from './crowd'
import {
  findResourceOfKind,
  requireSubnet,
  resourcesOfKind,
  type CidrPeer,
  type LoadBalancer,
  type PortOption,
  type RouteDestination,
  type RouteTarget,
  type Scene,
  type SecurityGroupPeer,
  type ServiceAction,
  type WafRule,
} from './model'
import { PORT_OPTIONS, portOptionCovers } from './ports'
import { resolveRoute } from './routing'
import { hasPublicStatement } from './s3'
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
  /** The load balancer sends requests to this cloud (an instance, or a whole Auto Scaling group). */
  | { kind: 'targets-include'; loadBalancerId: string; targetId: string }
  /** The Auto Scaling group has a scaling policy and room to grow: its maximum is above its minimum. */
  | { kind: 'group-can-scale'; groupId: string }
  /** None of these holds, e.g. neither fixed instance is a target any more. */
  | { kind: 'none-of'; predicates: Predicate[] }
  /** Every one of these holds, e.g. a network ACL rule in each direction. */
  | { kind: 'all-of'; predicates: Predicate[] }
  /** Every selected flow got its shell through Session Manager (Level 9). */
  | { kind: 'session-opened'; flows: FlowSelector }
  /** No security group has an inbound rule that lets this port in ("All traffic" does). */
  | { kind: 'security-groups-closed-to'; ports: PortOption }
  /** No security group or network ACL rule, in or out, names this port option. */
  | { kind: 'no-rule-names'; ports: PortOption }
  /** The Auto Scaling group's subnets span at least this many Availability Zones. */
  | { kind: 'group-spans-zones'; groupId: string; zones: number }
  /** The RDS database is Multi-AZ: it keeps a standby in another Availability Zone. */
  | { kind: 'database-multi-az'; databaseId: string }
  /**
   * The security group has an inbound rule allowing these ports from another security
   * group: the tiers are chained by name rather than by address.
   */
  | {
      kind: 'security-group-allows-group'
      securityGroupId: string
      ports: PortOption
      fromSecurityGroupId: string
    }
  /** Each of these subnets is associated with this network ACL. */
  | { kind: 'network-acl-on-subnets'; networkAclId: string; subnetIds: string[] }
  /** The network ACL has an allow rule, whatever its number, for these ports and this peer. */
  | {
      kind: 'network-acl-allows'
      networkAclId: string
      direction: 'inbound' | 'outbound'
      ports: PortOption
      peer: CidrPeer
    }
  /**
   * The network ACL's rule numbers leave room: in each direction the first is at least
   * `gap` and each is at least `gap` above the one before, so a rule can be slotted in
   * anywhere without renumbering (AWS recommends 100, 110, 120, not 101, 102, 103).
   */
  | { kind: 'network-acl-rules-spaced'; networkAclId: string; gap: number }
  /** A web ACL is associated with the load balancer and holds each of these kinds of rule. */
  | { kind: 'web-acl-protects'; loadBalancerId: string; rules: WafRule['kind'][] }
  /** Every inbound rule on every target names the load balancer's security group and nothing wider. */
  | { kind: 'targets-accept-only-load-balancer'; loadBalancerId: string }
  | { kind: 'role-attached'; instanceIds: string[] }
  | { kind: 'role-allows'; roleId: string; action: ServiceAction; resourceId: string }
  /** Block Public Access is on and the bucket policy grants nothing to everyone. */
  | { kind: 'bucket-locked-down'; bucketId: string }
  /** The bucket's default encryption is SSE-KMS with a customer managed key (an existing `kms-key`). */
  | { kind: 'bucket-encrypted-with-customer-key'; bucketId: string }
  /** The database is encrypted at rest, with any key. */
  | { kind: 'database-encrypted'; databaseId: string }
  /** Every one of these buckets and databases is encrypted under one and the same customer managed key. */
  | { kind: 'one-customer-key'; resourceIds: string[] }
  /**
   * Every subnet that holds an instance sends that service's traffic to a gateway
   * endpoint, so none of it leaves the AWS network (none of it "crosses the ground").
   */
  | { kind: 'service-routed-through-gateway-endpoint'; service: 's3' | 'dynamodb' }
  /** The scene's running cost is no more than this many coins (see cost.ts). */
  | { kind: 'cost-at-most'; coins: number }
  // --- about the crowd (levels with a `crowd`; see crowd.ts) ------------------
  /**
   * At least this percentage of the crowd's kites were delivered: over the whole run,
   * or, with `during: 'surge'`, only on the ticks while a crowd surge was under way.
   */
  | { kind: 'crowd-delivered-at-least'; percent: number; during?: 'surge' }
  /** More targets were in service at the busiest moment than at the end: capacity grew, then shrank. */
  | { kind: 'crowd-scaled-out-and-back-in' }
  /**
   * Before the crowd first grows, the targets are at least this busy: the fleet is not
   * oversized for the usual crowd, so nobody pays for instances that sit idle.
   */
  | { kind: 'crowd-quiet-cpu-at-least'; percent: number }
  /** On every tick, the healthy targets span at least this many Availability Zones. */
  | { kind: 'crowd-zones-at-least'; zones: number }
  /**
   * On the last tick of the run, every kite is answered: the application is still
   * working, database and all, after whatever happened during the run.
   */
  | { kind: 'crowd-answered-at-end' }
  /**
   * Kites fail only while a database is failing over: outside that period, which no
   * architecture can avoid, every kite is answered (needs a database and an outage).
   */
  | { kind: 'crowd-failures-only-during-failover' }

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

export function evaluatePredicate(
  authoredScene: Scene,
  runs: FlowRun[],
  predicate: Predicate,
  /** The crowd simulation's record, for levels that have a crowd. */
  crowd: CrowdRecord | null = null,
): boolean {
  // Predicates about instances should see an Auto Scaling group's instances too.
  const scene = expandAutoScalingGroups(authoredScene)
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
    case 'targets-include':
      // Asked of the scene as the player built it, where a group is one target.
      return (
        findResourceOfKind(
          authoredScene,
          'load-balancer',
          predicate.loadBalancerId,
        )?.targetIds.includes(predicate.targetId) ?? false
      )
    case 'group-can-scale': {
      const group = findResourceOfKind(authoredScene, 'auto-scaling-group', predicate.groupId)
      return group !== undefined && group.scaling !== null && group.max > group.min
    }
    case 'group-spans-zones': {
      const group = findResourceOfKind(authoredScene, 'auto-scaling-group', predicate.groupId)
      const zones = new Set(
        (group?.subnetIds ?? []).map(
          (id) => authoredScene.subnets.find((subnet) => subnet.id === id)?.availabilityZone,
        ),
      )
      return group !== undefined && zones.size >= predicate.zones
    }
    case 'database-multi-az':
      return (
        findResourceOfKind(authoredScene, 'rds-database', predicate.databaseId)?.multiAz ?? false
      )
    case 'security-group-allows-group':
      return (
        authoredScene.securityGroups
          .find((group) => group.id === predicate.securityGroupId)
          ?.inbound.some(
            (rule) =>
              rule.ports === predicate.ports &&
              rule.peer.kind === 'security-group' &&
              rule.peer.securityGroupId === predicate.fromSecurityGroupId,
          ) ?? false
      )
    case 'network-acl-on-subnets':
      return predicate.subnetIds.every(
        (id) =>
          authoredScene.subnets.find((subnet) => subnet.id === id)?.networkAclId ===
          predicate.networkAclId,
      )
    case 'network-acl-allows':
      return (
        authoredScene.networkAcls
          .find((acl) => acl.id === predicate.networkAclId)
          ?.[predicate.direction].some(
            (rule) =>
              rule.action === 'allow' &&
              rule.ports === predicate.ports &&
              rule.peer.kind === predicate.peer.kind &&
              (rule.peer.kind === 'anywhere' ||
                (predicate.peer.kind === 'cidr' && rule.peer.cidr === predicate.peer.cidr)),
          ) ?? false
      )
    case 'network-acl-rules-spaced': {
      const acl = authoredScene.networkAcls.find((each) => each.id === predicate.networkAclId)
      if (!acl) return false
      return (['inbound', 'outbound'] as const).every((direction) => {
        const numbers = acl[direction].map((rule) => rule.number).sort((a, b) => a - b)
        return numbers.every(
          (number, index) => number - (index === 0 ? 0 : numbers[index - 1]!) >= predicate.gap,
        )
      })
    }
    case 'web-acl-protects': {
      const acl = authoredScene.resources.find(
        (resource) =>
          resource.kind === 'waf-web-acl' && resource.loadBalancerId === predicate.loadBalancerId,
      )
      return (
        acl?.kind === 'waf-web-acl' &&
        predicate.rules.every((kind) => acl.rules.some((rule) => rule.kind === kind))
      )
    }
    case 'crowd-answered-at-end': {
      const last = crowd?.ticks.at(-1)
      return last !== undefined && last.demand > 0 && last.delivered === last.demand
    }
    case 'crowd-failures-only-during-failover':
      return (
        crowd !== null &&
        crowd.ticks.length > 0 &&
        crowd.ticks.every(
          (tick) =>
            tick.delivered === tick.demand ||
            tick.databases.some((database) => database.status === 'failing-over'),
        )
      )
    case 'none-of':
      return predicate.predicates.every(
        (inner) => !evaluatePredicate(authoredScene, runs, inner, crowd),
      )
    case 'all-of':
      return predicate.predicates.every((inner) =>
        evaluatePredicate(authoredScene, runs, inner, crowd),
      )
    case 'session-opened': {
      const selected = selectRuns(runs, predicate.flows)
      const sessionManagerIds = new Set(
        resourcesOfKind(scene, 'session-manager').map((resource) => resource.id),
      )
      return (
        selected.length > 0 &&
        selected.every(
          (run) =>
            run.result.outcome === 'delivered' &&
            run.result.trace.some(
              (step) => step.at.kind === 'resource' && sessionManagerIds.has(step.at.id),
            ),
        )
      )
    }
    case 'security-groups-closed-to': {
      const port = PORT_OPTIONS[predicate.ports].from
      return scene.securityGroups.every((group) =>
        group.inbound.every((rule) => !portOptionCovers(rule.ports, port)),
      )
    }
    case 'no-rule-names':
      return (
        scene.securityGroups.every((group) =>
          [...group.inbound, ...group.outbound].every((rule) => rule.ports !== predicate.ports),
        ) &&
        scene.networkAcls.every((acl) =>
          [...acl.inbound, ...acl.outbound].every((rule) => rule.ports !== predicate.ports),
        )
      )
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
    case 'bucket-locked-down': {
      const bucket = findResourceOfKind(scene, 's3-bucket', predicate.bucketId)
      return bucket !== undefined && bucket.blockPublicAccess && !hasPublicStatement(bucket)
    }
    case 'bucket-encrypted-with-customer-key': {
      const key = customerKeyOf(scene, predicate.bucketId)
      return key !== undefined
    }
    case 'database-encrypted':
      return (
        findResourceOfKind(scene, 'rds-database', predicate.databaseId)?.encryption.kind === 'kms'
      )
    case 'one-customer-key': {
      const keys = predicate.resourceIds.map((id) => customerKeyOf(scene, id))
      return keys.length > 0 && keys.every((key) => key !== undefined && key === keys[0])
    }
    case 'service-routed-through-gateway-endpoint': {
      // Asked of the routing rules, not read off the route tables: where would
      // this service's traffic actually go from each instance's subnet?
      const instances = resourcesOfKind(scene, 'ec2-instance')
      return (
        instances.length > 0 &&
        instances.every((instance) => {
          const subnet = requireSubnet(scene, instance.subnetId)
          return resolveRoute(scene, subnet, predicate.service).kind === 'gateway-endpoint'
        })
      )
    }
    case 'cost-at-most':
      // Costed on the scene as built: a group is charged for the instances it starts with.
      return costOfScene(authoredScene).total <= predicate.coins
    case 'crowd-delivered-at-least': {
      if (crowd === null) return false
      const ticks =
        predicate.during === 'surge' ? crowd.ticks.filter((tick) => tick.surge) : crowd.ticks
      // A level that asks about a surge it never has cannot be satisfied by accident.
      return ticks.length > 0 && deliveredShare(ticks).percent >= predicate.percent
    }
    case 'crowd-scaled-out-and-back-in':
      return (
        crowd !== null &&
        crowd.peakTargetsInService > crowd.finalTargetsInService &&
        crowd.finalTargetsInService > 0
      )
    case 'crowd-quiet-cpu-at-least': {
      if (crowd === null) return false
      const firstBusy = crowd.ticks.findIndex((tick) => tick.surge)
      // A crowd that never grows has no quiet start to judge, so this cannot be met by accident.
      if (firstBusy <= 0) return false
      return crowd.ticks.slice(0, firstBusy).every((tick) => tick.cpuPercent >= predicate.percent)
    }
    case 'crowd-zones-at-least':
      return (
        crowd !== null &&
        crowd.ticks.length > 0 &&
        crowd.ticks.every((tick) => tick.zonesInService >= predicate.zones)
      )
  }
}

export function evaluateObjectives(
  scene: Scene,
  runs: FlowRun[],
  objectives: Objective[],
  crowd: CrowdRecord | null = null,
): ObjectiveResult[] {
  return objectives.map((objective) => ({
    id: objective.id,
    text: objective.text,
    met: evaluatePredicate(scene, runs, objective.predicate, crowd),
  }))
}

/**
 * The id of the customer managed key a bucket's default encryption or a database's
 * encryption at rest uses, if any. AWS managed keys and SSE-S3 give undefined.
 */
function customerKeyOf(scene: Scene, resourceId: string): string | undefined {
  const resource = scene.resources.find((candidate) => candidate.id === resourceId)
  const keyId =
    resource?.kind === 's3-bucket' && resource.encryption.kind === 'sse-kms'
      ? resource.encryption.keyId
      : resource?.kind === 'rds-database' && resource.encryption.kind === 'kms'
        ? resource.encryption.keyId
        : null
  return keyId !== null && findResourceOfKind(scene, 'kms-key', keyId) ? keyId : undefined
}
