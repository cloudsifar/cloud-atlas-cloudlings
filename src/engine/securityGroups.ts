// Security groups: stateful, allow-only firewalls worn by individual resources.

import { cidrPeerContains, describeCidrPeer } from './address'
import { requireSecurityGroup, type Scene, type SecurityGroupPeer } from './model'
import { describePort, PORT_OPTIONS, portOptionCovers } from './ports'
import type { CheckOutcome } from './trace'

/** The other end of the connection, as a security group sees it. */
export type ConnectionPeer = {
  ip: string
  /** The security groups the peer wears (empty for anything outside the VPC). */
  securityGroupIds: string[]
  /** For explanations, e.g. 'the load balancer' or 'the Cloudling at 203.0.113.10'. */
  description: string
}

function peerMatches(rulePeer: SecurityGroupPeer, peer: ConnectionPeer): boolean {
  // "Another security group" means: any resource wearing that group.
  if (rulePeer.kind === 'security-group') {
    return peer.securityGroupIds.includes(rulePeer.securityGroupId)
  }
  return cidrPeerContains(rulePeer, peer.ip)
}

function describePeer(scene: Scene, rulePeer: SecurityGroupPeer): string {
  return rulePeer.kind === 'security-group'
    ? `security group "${requireSecurityGroup(scene, rulePeer.securityGroupId).name}"`
    : describeCidrPeer(rulePeer)
}

/**
 * AWS behaviour modelled: a security group holds allow rules only. All rules of
 * all groups on the resource are evaluated together (order is irrelevant); the
 * connection is allowed if any one rule matches, and denied if none does.
 * With no rules in the given direction, everything in that direction is denied.
 *
 * Statefulness is not decided here: the flow evaluator simply never calls this
 * for return traffic, because return traffic of an allowed connection is always allowed.
 */
export function evaluateSecurityGroups(
  scene: Scene,
  securityGroupIds: string[],
  direction: 'inbound' | 'outbound',
  peer: ConnectionPeer,
  port: number,
): CheckOutcome {
  for (const id of securityGroupIds) {
    const group = requireSecurityGroup(scene, id)
    const rules = group[direction]
    const index = rules.findIndex(
      (rule) => portOptionCovers(rule.ports, port) && peerMatches(rule.peer, peer),
    )
    const rule = rules[index]
    if (rule) {
      const preposition = direction === 'inbound' ? 'from' : 'to'
      return {
        result: 'pass',
        ruleRef: `${group.name}: allow ${PORT_OPTIONS[rule.ports].label} ${preposition} ${describePeer(scene, rule.peer)}`,
        matched: { kind: 'security-group-rule', securityGroupId: id, direction, index },
        explanation: `Security group "${group.name}" has a rule allowing ${PORT_OPTIONS[rule.ports].label} ${preposition} ${describePeer(scene, rule.peer)}, which covers ${peer.description}.`,
      }
    }
  }
  const names = securityGroupIds.map((id) => `"${requireSecurityGroup(scene, id).name}"`).join(', ')
  const preposition = direction === 'inbound' ? 'from' : 'to'
  return {
    result: 'fail',
    ruleRef: 'no matching allow rule',
    explanation:
      securityGroupIds.length === 0
        ? `No security group is attached, so nothing is allowed ${direction}.`
        : `Security group ${names} has no ${direction} rule allowing ${describePort(port)} ${preposition} ${peer.description}. Security groups only allow; anything not allowed is refused.`,
  }
}
