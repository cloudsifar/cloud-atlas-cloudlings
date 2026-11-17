// Edits: every change the player can make to a scene, as a pure function.
//
// Each function takes a scene and returns a new one; the input is never touched.
// That is what makes undo trivial (keep the old scenes) and keeps the engine's
// inputs trustworthy. The UI never changes a scene any other way.

import type {
  LoadBalancer,
  PolicyStatement,
  Resource,
  ResourceKind,
  Route,
  RouteDestination,
  Scene,
  SecurityGroupRule,
  Subnet,
  AutoScalingGroup,
} from '../engine'
import type { PaletteEntry } from '../levels'

function edit(scene: Scene, change: (draft: Scene) => void): Scene {
  const draft = structuredClone(scene)
  change(draft)
  return draft
}

function changeResource<K extends ResourceKind>(
  scene: Scene,
  kind: K,
  id: string,
  change: (resource: Extract<Resource, { kind: K }>) => void,
): Scene {
  return edit(scene, (draft) => {
    const resource = draft.resources.find((candidate) => candidate.id === id)
    if (resource?.kind === kind) change(resource as Extract<Resource, { kind: K }>)
  })
}

/** The subnets a kind of resource may sit in. Empty for resources that are not in a subnet. */
export function validSubnetsFor(scene: Scene, kind: ResourceKind): Subnet[] {
  if (kind === 'nat-gateway') return scene.subnets.filter((subnet) => subnet.band === 'low')
  if (kind === 'ec2-instance') return scene.subnets.filter((subnet) => subnet.band === 'mid')
  return []
}

/** Adds a cloud from the palette. `subnetId` is needed only for subnet-bound kinds. */
export function placeFromPalette(scene: Scene, entry: PaletteEntry, subnetId?: string): Scene {
  return edit(scene, (draft) => {
    const resource = structuredClone(entry.resource)
    if (resource.kind === 'load-balancer') {
      // A load balancer takes one subnet per Availability Zone: every low-band subnet.
      resource.subnetIds = draft.subnets
        .filter((subnet) => subnet.band === 'low')
        .map((subnet) => subnet.id)
    }
    if (resource.kind === 'nat-gateway' || resource.kind === 'ec2-instance') {
      resource.subnetId = subnetId ?? validSubnetsFor(draft, resource.kind)[0]?.id ?? ''
    }
    draft.resources.push(resource)
    for (const group of entry.securityGroups ?? []) {
      if (!draft.securityGroups.some((existing) => existing.id === group.id)) {
        draft.securityGroups.push(structuredClone(group))
      }
    }
  })
}

export function moveToSubnet(scene: Scene, resourceId: string, subnetId: string): Scene {
  return edit(scene, (draft) => {
    const resource = draft.resources.find((candidate) => candidate.id === resourceId)
    if (resource?.kind === 'nat-gateway' || resource?.kind === 'ec2-instance')
      resource.subnetId = subnetId
  })
}

/** Removes a cloud and everything that only made sense while it existed. */
export function removeResource(scene: Scene, id: string): Scene {
  return edit(scene, (draft) => {
    const removed = draft.resources.find((resource) => resource.id === id)
    if (!removed) return
    draft.resources = draft.resources.filter((resource) => resource.id !== id)

    for (const resource of draft.resources) {
      if (resource.kind === 'load-balancer')
        resource.targetIds = resource.targetIds.filter((target) => target !== id)
      if (resource.kind === 'ec2-instance' && resource.roleId === id) resource.roleId = null
      if (resource.kind === 'iam-role') {
        resource.statements = resource.statements.filter((statement) => statement.resource !== id)
      }
    }
    for (const table of draft.routeTables) {
      table.routes = table.routes.filter(
        (route) =>
          !(removed.kind === 'internet-gateway' && route.target.kind === 'internet-gateway') &&
          !(route.target.kind === 'nat-gateway' && route.target.natGatewayId === id),
      )
    }
    // Security groups that nothing wears and no rule mentions go with their cloud.
    if ('securityGroupIds' in removed) {
      for (const groupId of removed.securityGroupIds) {
        const worn = draft.resources.some(
          (resource) =>
            'securityGroupIds' in resource && resource.securityGroupIds.includes(groupId),
        )
        const mentioned = draft.securityGroups.some((group) =>
          [...group.inbound, ...group.outbound].some(
            (rule) => rule.peer.kind === 'security-group' && rule.peer.securityGroupId === groupId,
          ),
        )
        if (!worn && !mentioned) {
          draft.securityGroups = draft.securityGroups.filter((group) => group.id !== groupId)
        }
      }
    }
  })
}

/** Adds a route, replacing any existing route for the same destination. */
export function setRoute(scene: Scene, routeTableId: string, route: Route): Scene {
  return edit(scene, (draft) => {
    const table = draft.routeTables.find((candidate) => candidate.id === routeTableId)
    if (!table) return
    table.routes = [
      ...table.routes.filter((existing) => existing.destination !== route.destination),
      route,
    ]
  })
}

export function removeRoute(
  scene: Scene,
  routeTableId: string,
  destination: RouteDestination,
): Scene {
  return edit(scene, (draft) => {
    const table = draft.routeTables.find((candidate) => candidate.id === routeTableId)
    if (table) table.routes = table.routes.filter((route) => route.destination !== destination)
  })
}

export function addSecurityGroupRule(
  scene: Scene,
  groupId: string,
  direction: 'inbound' | 'outbound',
  rule: SecurityGroupRule,
): Scene {
  return edit(scene, (draft) => {
    const rules = draft.securityGroups.find((group) => group.id === groupId)?.[direction]
    const duplicate = rules?.some((existing) => JSON.stringify(existing) === JSON.stringify(rule))
    if (rules && !duplicate) rules.push(rule)
  })
}

export function removeSecurityGroupRule(
  scene: Scene,
  groupId: string,
  direction: 'inbound' | 'outbound',
  index: number,
): Scene {
  return edit(scene, (draft) => {
    draft.securityGroups.find((group) => group.id === groupId)?.[direction].splice(index, 1)
  })
}

export function setListener(
  scene: Scene,
  loadBalancerId: string,
  listener: LoadBalancer['listener'],
): Scene {
  return changeResource(scene, 'load-balancer', loadBalancerId, (loadBalancer) => {
    loadBalancer.listener = listener
  })
}

export function setTargetRegistered(
  scene: Scene,
  loadBalancerId: string,
  instanceId: string,
  registered: boolean,
): Scene {
  return changeResource(scene, 'load-balancer', loadBalancerId, (loadBalancer) => {
    const others = loadBalancer.targetIds.filter((target) => target !== instanceId)
    loadBalancer.targetIds = registered ? [...others, instanceId] : others
  })
}

/**
 * Changes an Auto Scaling group's settings. As in AWS, desired capacity always lies
 * between the minimum and the maximum, so changing one limit can move it. The game
 * keeps at least one instance (a minimum of 0 is left out; docs/SIMPLIFICATIONS.md).
 */
export function setGroupSettings(
  scene: Scene,
  groupId: string,
  change: Partial<
    Pick<AutoScalingGroup, 'min' | 'desired' | 'max' | 'size' | 'scaling' | 'roleId'>
  >,
): Scene {
  return changeResource(scene, 'auto-scaling-group', groupId, (group) => {
    Object.assign(group, change)
    group.min = Math.max(1, group.min)
    group.max = Math.max(1, group.max)
    // Raising the minimum past the maximum lifts the maximum, and lowering the maximum
    // below the minimum lowers the minimum: whichever limit the player moved wins.
    if (change.max !== undefined) group.min = Math.min(group.min, group.max)
    else group.max = Math.max(group.min, group.max)
    group.desired = Math.min(Math.max(group.desired, group.min), group.max)
  })
}

export function setInstanceRole(scene: Scene, instanceId: string, roleId: string | null): Scene {
  return changeResource(scene, 'ec2-instance', instanceId, (instance) => {
    instance.roleId = roleId
  })
}

export function addRoleStatement(scene: Scene, roleId: string, statement: PolicyStatement): Scene {
  return changeResource(scene, 'iam-role', roleId, (role) => {
    const duplicate = role.statements.some(
      (existing) => JSON.stringify(existing) === JSON.stringify(statement),
    )
    if (!duplicate) role.statements.push(statement)
  })
}

export function removeRoleStatement(scene: Scene, roleId: string, index: number): Scene {
  return changeResource(scene, 'iam-role', roleId, (role) => {
    role.statements.splice(index, 1)
  })
}

export function setBlockPublicAccess(scene: Scene, bucketId: string, on: boolean): Scene {
  return changeResource(scene, 's3-bucket', bucketId, (bucket) => {
    bucket.blockPublicAccess = on
  })
}

/** Adds or removes the statement "allow s3:Read to everyone" on a bucket's policy. */
export function setPublicRead(scene: Scene, bucketId: string, on: boolean): Scene {
  return changeResource(scene, 's3-bucket', bucketId, (bucket) => {
    bucket.policy = bucket.policy.filter(
      (statement) => !(statement.effect === 'allow' && statement.principal.kind === 'everyone'),
    )
    if (on)
      bucket.policy.push({ effect: 'allow', principal: { kind: 'everyone' }, actions: ['s3:Read'] })
  })
}

export type ConnectionResult = { ok: true; scene: Scene } | { ok: false; reason: string }

/**
 * Dragging from one cloud's handle to another. Only connections that mean
 * something in AWS are accepted; anything else returns a one-line reason.
 */
export function connect(scene: Scene, fromId: string, toId: string): ConnectionResult {
  const from = scene.resources.find((resource) => resource.id === fromId)
  const to = scene.resources.find((resource) => resource.id === toId)
  if (!from || !to) return { ok: false, reason: 'There is nothing there to connect to.' }

  if (
    from.kind === 'load-balancer' &&
    (to.kind === 'ec2-instance' || to.kind === 'auto-scaling-group')
  ) {
    return { ok: true, scene: setTargetRegistered(scene, from.id, to.id, true) }
  }
  if (from.kind === 'iam-role' && to.kind === 'ec2-instance') {
    return { ok: true, scene: setInstanceRole(scene, to.id, from.id) }
  }
  if (from.kind === 'load-balancer') {
    return {
      ok: false,
      reason:
        'A load balancer sends requests to compute: connect it to an EC2 instance or an Auto Scaling group.',
    }
  }
  if (from.kind === 'iam-role') {
    return { ok: false, reason: 'A role is worn by compute: connect it to an EC2 instance.' }
  }
  return { ok: false, reason: `${from.name} has nothing to connect.` }
}

/** Which kinds of cloud have a connector handle. */
export function canStartConnection(kind: ResourceKind): boolean {
  return kind === 'load-balancer' || kind === 'iam-role'
}
