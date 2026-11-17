// Auto Scaling groups: turning "a group that wants N instances" into instances.
//
// AWS behaviour modelled:
// - A group keeps `desired` instances running, never fewer than `min` or more than `max`.
// - It spreads them evenly across its subnets (and so across Availability Zones).
// - Every instance is identical: same size, security groups and role (in AWS these
//   come from the launch template).
// - When the group is attached to a load balancer, its instances are registered as
//   targets automatically.
//
// The rest of the engine only understands individual instances, so before a flow is
// evaluated each group is expanded into ordinary instances. Nothing else needs to
// know that groups exist.

import { resourcesOfKind, type AutoScalingGroup, type Ec2Instance, type Scene } from './model'

/** The id of a group's nth instance (1-based). The '#' cannot appear in a level-authored id. */
export function groupInstanceId(groupId: string, index: number): string {
  return `${groupId}#${index}`
}

/** `desired`, held within the group's min and max. */
export function runningCount(group: AutoScalingGroup): number {
  return Math.min(Math.max(group.desired, group.min), group.max)
}

/** The instances a group is running right now, spread across its subnets in turn. */
export function groupInstances(group: AutoScalingGroup): Ec2Instance[] {
  if (group.subnetIds.length === 0) return []
  return Array.from({ length: runningCount(group) }, (_, index) => ({
    kind: 'ec2-instance' as const,
    id: groupInstanceId(group.id, index + 1),
    name: `${group.name} instance ${index + 1}`,
    subnetId: group.subnetIds[index % group.subnetIds.length]!,
    securityGroupIds: group.securityGroupIds,
    roleId: group.roleId,
    size: group.size,
    healthy: true,
  }))
}

/**
 * A copy of the scene in which every group's instances exist as ordinary instances,
 * and any load balancer targeting a group targets those instances instead.
 * The groups themselves stay in the scene. Expanding twice changes nothing.
 */
export function expandAutoScalingGroups(scene: Scene): Scene {
  const groups = resourcesOfKind(scene, 'auto-scaling-group')
  if (groups.length === 0) return scene

  const existing = new Set(scene.resources.map((resource) => resource.id))
  const instancesOf = new Map(groups.map((group) => [group.id, groupInstances(group)]))
  const added = [...instancesOf.values()].flat().filter((instance) => !existing.has(instance.id))

  return {
    ...scene,
    resources: [
      ...scene.resources.map((resource) =>
        resource.kind === 'load-balancer'
          ? {
              ...resource,
              targetIds: resource.targetIds.flatMap(
                (id) => instancesOf.get(id)?.map((instance) => instance.id) ?? [id],
              ),
            }
          : resource,
      ),
      ...added,
    ],
  }
}
