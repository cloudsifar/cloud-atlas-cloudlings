// Network ACLs: stateless, ordered allow/deny lists on the boundary of a subnet.

import { cidrPeerContains, describeCidrPeer } from './address'
import type { NetworkAcl } from './model'
import { describePort, PORT_OPTIONS, portOptionCovers } from './ports'
import type { CheckOutcome } from './trace'

/**
 * AWS behaviour modelled: rules are evaluated in ascending rule-number order and
 * the first rule that matches decides, whether it allows or denies. If no
 * numbered rule matches, the final '*' rule denies. Inbound and outbound lists
 * are separate and each packet is judged on its own, so a reply needs its own
 * rule (NACLs are stateless).
 *
 * `peerIp` is the packet's source for inbound checks and its destination for outbound checks.
 */
export function evaluateNetworkAcl(
  acl: NetworkAcl,
  direction: 'inbound' | 'outbound',
  peerIp: string,
  port: number,
): CheckOutcome {
  const ordered = [...acl[direction]].sort((first, second) => first.number - second.number)
  const rule = ordered.find(
    (candidate) =>
      portOptionCovers(candidate.ports, port) && cidrPeerContains(candidate.peer, peerIp),
  )
  const preposition = direction === 'inbound' ? 'from' : 'to'
  if (!rule) {
    return {
      result: 'fail',
      ruleRef: 'NACL rule * (deny)',
      explanation: `Network ACL "${acl.name}" has no ${direction} rule matching ${describePort(port)} ${preposition} ${peerIp}, so the final * rule denies it.`,
    }
  }
  const summary = `${rule.action} ${PORT_OPTIONS[rule.ports].label} ${preposition} ${describeCidrPeer(rule.peer)}`
  return {
    result: rule.action === 'allow' ? 'pass' : 'fail',
    ruleRef: `NACL rule ${rule.number} (${rule.action})`,
    matched: { kind: 'nacl-rule', networkAclId: acl.id, direction, number: rule.number },
    explanation: `Network ACL "${acl.name}" ${direction} rule ${rule.number} is the first to match: ${summary}.`,
  }
}
