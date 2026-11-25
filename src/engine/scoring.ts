// scoreScene: the least-privilege star. Does anything open more than the level needs?
//
// "Needs" is measured, not guessed: the rules and statements that the friendly
// kites actually relied on are read from their traces (`TraceStep.matched`).
// Anything the player may edit that was not relied on, or is wider than the
// traffic that relied on it, is reported as a finding.

import { resourcesOfKind, type Scene } from './model'
import { hasPublicStatement } from './s3'
import type { FlowRun } from './predicates'
import type { RuleMatch } from './trace'

export type Finding = {
  /** The security group, network ACL, role or bucket the finding is about. */
  subjectId: string
  message: string
}

function matchesUsedByFriendlyKites(runs: FlowRun[]): RuleMatch[] {
  return runs
    .filter((run) => run.flow.intent === 'legitimate' && run.result.outcome === 'delivered')
    .flatMap((run) => [...run.result.trace, ...(run.result.responseTrace ?? [])])
    .map((step) => step.matched)
    .filter((match): match is RuleMatch => match !== undefined)
}

/**
 * `lockedIds` are things the level does not let the player change; they are
 * never reported, because the player could not fix them.
 */
export function scoreScene(scene: Scene, runs: FlowRun[], lockedIds: string[]): Finding[] {
  const findings: Finding[] = []
  const used = matchesUsedByFriendlyKites(runs)
  const editable = (id: string) => !lockedIds.includes(id)

  // Security groups worn by an internet-facing load balancer legitimately face the internet.
  const internetFacingGroupIds = new Set(
    resourcesOfKind(scene, 'load-balancer')
      .filter((loadBalancer) => loadBalancer.scheme === 'internet-facing')
      .flatMap((loadBalancer) => loadBalancer.securityGroupIds),
  )

  for (const group of scene.securityGroups.filter((candidate) => editable(candidate.id))) {
    group.inbound.forEach((rule, index) => {
      const relied = used.some(
        (match) =>
          match.kind === 'security-group-rule' &&
          match.securityGroupId === group.id &&
          match.direction === 'inbound' &&
          match.index === index,
      )
      if (!relied) {
        findings.push({
          subjectId: group.id,
          message: `Security group "${group.name}" has an inbound rule that no friendly kite needs.`,
        })
      } else if (rule.ports === 'all') {
        findings.push({
          subjectId: group.id,
          message: `Security group "${group.name}" allows all traffic where one port would do.`,
        })
      } else if (rule.peer.kind !== 'security-group' && !internetFacingGroupIds.has(group.id)) {
        // Nothing outside the VPC can reach this resource, so an address range is
        // wider than needed: naming the sender's security group is exact.
        findings.push({
          subjectId: group.id,
          message: `Security group "${group.name}" allows a whole address range. Only another tier talks to it, so name that tier's security group instead.`,
        })
      }
    })
  }

  // Network ACLs the player may edit (not the VPC's default one): every allow rule
  // should be one a visitor's kite relied on, and none should open all traffic. Deny
  // rules only ever narrow, so they are never a finding.
  for (const acl of scene.networkAcls.filter(
    (candidate) => editable(candidate.id) && !candidate.isDefault,
  )) {
    for (const direction of ['inbound', 'outbound'] as const) {
      for (const rule of acl[direction]) {
        if (rule.action !== 'allow') continue
        const relied = used.some(
          (match) =>
            match.kind === 'nacl-rule' &&
            match.networkAclId === acl.id &&
            match.direction === direction &&
            match.number === rule.number,
        )
        if (!relied) {
          findings.push({
            subjectId: acl.id,
            message: `Network ACL "${acl.name}" has an ${direction} allow rule (${rule.number}) that no visitor's kite needs.`,
          })
        } else if (rule.ports === 'all') {
          findings.push({
            subjectId: acl.id,
            message: `Network ACL "${acl.name}" allows all traffic ${direction === 'inbound' ? 'in' : 'out'} (rule ${rule.number}) where one port range would do.`,
          })
        }
      }
    }
  }

  for (const role of resourcesOfKind(scene, 'iam-role').filter((candidate) =>
    editable(candidate.id),
  )) {
    role.statements.forEach((statement, index) => {
      if (statement.effect !== 'allow') return
      if (statement.resource === '*') {
        findings.push({
          subjectId: role.id,
          message: `Role "${role.name}" grants access to every resource (*). Name the one it uses.`,
        })
      }
      for (const action of statement.actions) {
        const relied = used.some(
          (match) =>
            match.kind === 'role-statement' &&
            match.roleId === role.id &&
            match.index === index &&
            match.action === action,
        )
        if (!relied) {
          findings.push({
            subjectId: role.id,
            message: `Role "${role.name}" allows ${action}, which the application never uses.`,
          })
        }
      }
    })
  }

  for (const bucket of resourcesOfKind(scene, 's3-bucket').filter((candidate) =>
    editable(candidate.id),
  )) {
    if (bucket.dataClass === 'sensitive' && !bucket.blockPublicAccess) {
      findings.push({
        subjectId: bucket.id,
        message: `Bucket "${bucket.name}" holds sensitive data but has Block Public Access switched off.`,
      })
    }
    if (bucket.dataClass === 'sensitive' && hasPublicStatement(bucket)) {
      findings.push({
        subjectId: bucket.id,
        message: `The policy of bucket "${bucket.name}" grants access to everyone.`,
      })
    }
  }

  return findings
}
