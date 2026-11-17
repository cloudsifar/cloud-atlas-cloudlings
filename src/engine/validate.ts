// validateScene: structural problems in a scene, found without flying any kites.

import {
  resourcesOfKind,
  type Scene,
  type SecurityGroupRule,
} from './model'
import { isPublicSubnet } from './routing'

export type SceneProblem = {
  /**
   * 'broken-reference': the data points at something that does not exist. A level
   *   file with one of these is malformed, and evaluation may throw.
   * 'misconfiguration': valid data describing an architecture that cannot work in AWS.
   *   The game shows these to the player.
   */
  severity: 'broken-reference' | 'misconfiguration'
  /** The id of the thing the problem is about. */
  subjectId: string
  message: string
}

export function validateScene(scene: Scene): SceneProblem[] {
  const problems: SceneProblem[] = []
  const broken = (subjectId: string, message: string) =>
    problems.push({ severity: 'broken-reference', subjectId, message })
  const misconfigured = (subjectId: string, message: string) =>
    problems.push({ severity: 'misconfiguration', subjectId, message })

  const subnetIds = new Set(scene.subnets.map((subnet) => subnet.id))
  const routeTableIds = new Set(scene.routeTables.map((table) => table.id))
  const aclIds = new Set(scene.networkAcls.map((acl) => acl.id))
  const groupIds = new Set(scene.securityGroups.map((group) => group.id))
  const resourceIds = new Set(scene.resources.map((resource) => resource.id))

  // Every id must be unique across the whole scene, so a bare id is never ambiguous.
  const allIds = [
    ...scene.subnets,
    ...scene.routeTables,
    ...scene.networkAcls,
    ...scene.securityGroups,
    ...scene.resources,
  ].map((item) => item.id)
  for (const id of new Set(allIds.filter((id, index) => allIds.indexOf(id) !== index))) {
    broken(id, `The id "${id}" is used more than once.`)
  }

  for (const subnet of scene.subnets) {
    if (!routeTableIds.has(subnet.routeTableId)) {
      broken(subnet.id, `Subnet "${subnet.name}" names a route table that does not exist.`)
    }
    if (!aclIds.has(subnet.networkAclId)) {
      broken(subnet.id, `Subnet "${subnet.name}" names a network ACL that does not exist.`)
    }
  }

  for (const table of scene.routeTables) {
    const destinations = table.routes.map((route) => route.destination)
    if (new Set(destinations).size !== destinations.length) {
      misconfigured(table.id, `Route table "${table.name}" has two routes for the same destination.`)
    }
    for (const route of table.routes) {
      if (route.target.kind === 'nat-gateway' && !resourceIds.has(route.target.natGatewayId)) {
        misconfigured(table.id, `Route table "${table.name}" points at a NAT Gateway that no longer exists.`)
      }
      if (route.target.kind === 'internet-gateway' && resourcesOfKind(scene, 'internet-gateway').length === 0) {
        misconfigured(table.id, `Route table "${table.name}" points at an Internet Gateway, but none is attached.`)
      }
      // A gateway endpoint is reached through its own service's prefix list and nothing else.
      const endpointMismatch =
        (route.target.kind === 'gateway-endpoint') !== (route.destination !== 'internet') ||
        (route.target.kind === 'gateway-endpoint' && route.target.service !== route.destination)
      if (endpointMismatch) {
        misconfigured(table.id, `Route table "${table.name}" pairs a destination with the wrong kind of target.`)
      }
    }
  }

  for (const acl of scene.networkAcls) {
    for (const direction of ['inbound', 'outbound'] as const) {
      const numbers = acl[direction].map((rule) => rule.number)
      if (new Set(numbers).size !== numbers.length) {
        misconfigured(acl.id, `Network ACL "${acl.name}" has two ${direction} rules with the same number.`)
      }
    }
  }

  const checkRules = (groupId: string, rules: SecurityGroupRule[]) => {
    for (const rule of rules) {
      if (rule.peer.kind === 'security-group' && !groupIds.has(rule.peer.securityGroupId)) {
        broken(groupId, `A rule in security group "${groupId}" names a security group that does not exist.`)
      }
    }
  }
  for (const group of scene.securityGroups) {
    checkRules(group.id, group.inbound)
    checkRules(group.id, group.outbound)
  }

  if (resourcesOfKind(scene, 'internet-gateway').length > 1) {
    misconfigured('vpc', 'A VPC can have only one Internet Gateway attached.')
  }

  for (const resource of scene.resources) {
    const requireGroups = (ids: string[]) => {
      for (const id of ids) {
        if (!groupIds.has(id)) broken(resource.id, `"${resource.name}" wears a security group that does not exist.`)
      }
    }
    switch (resource.kind) {
      case 'nat-gateway': {
        const subnet = scene.subnets.find((candidate) => candidate.id === resource.subnetId)
        if (!subnet) broken(resource.id, `"${resource.name}" is in a subnet that does not exist.`)
        else if (!isPublicSubnet(scene, subnet)) {
          misconfigured(resource.id, `"${resource.name}" must sit in a public subnet: it needs a route to the Internet Gateway to do its job.`)
        }
        break
      }
      case 'load-balancer': {
        requireGroups(resource.securityGroupIds)
        const subnets = scene.subnets.filter((subnet) => resource.subnetIds.includes(subnet.id))
        if (subnets.length !== resource.subnetIds.length) {
          broken(resource.id, `"${resource.name}" is in a subnet that does not exist.`)
        }
        if (new Set(subnets.map((subnet) => subnet.availabilityZone)).size < 2) {
          misconfigured(resource.id, `"${resource.name}" needs subnets in at least two Availability Zones.`)
        }
        for (const targetId of resource.targetIds) {
          if (!resourceIds.has(targetId)) broken(resource.id, `"${resource.name}" has a target that does not exist.`)
        }
        break
      }
      case 'ec2-instance':
        requireGroups(resource.securityGroupIds)
        if (!subnetIds.has(resource.subnetId)) broken(resource.id, `"${resource.name}" is in a subnet that does not exist.`)
        if (resource.roleId !== null && !resourceIds.has(resource.roleId)) {
          broken(resource.id, `"${resource.name}" has a role that does not exist.`)
        }
        break
      case 's3-bucket':
        for (const statement of resource.policy) {
          if (statement.principal.kind === 'role' && !resourceIds.has(statement.principal.roleId)) {
            broken(resource.id, `The bucket policy of "${resource.name}" names a role that does not exist.`)
          }
        }
        break
      case 'iam-role':
        for (const statement of resource.statements) {
          if (statement.resource !== '*' && !resourceIds.has(statement.resource)) {
            misconfigured(resource.id, `Role "${resource.name}" has a statement about a resource that no longer exists.`)
          }
        }
        break
      case 'internet-gateway':
        break
    }
  }

  return problems
}
