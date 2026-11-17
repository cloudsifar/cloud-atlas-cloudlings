// IAM identity policies: what a role is allowed to do.

import type { IamRole, ServiceAction } from './model'

export type IdentityDecision =
  | { verdict: 'explicit-deny'; index: number }
  | { verdict: 'allow'; index: number }
  | { verdict: 'no-match' }

/**
 * AWS behaviour modelled: a request is denied unless a statement allows it
 * (implicit deny), and one matching Deny statement overrides every Allow.
 * This function reports what the role's own policy says; the caller combines it
 * with any resource policy (see s3.ts), because within one account an allow
 * from either side is enough.
 */
export function evaluateIdentityPolicy(
  role: IamRole,
  action: ServiceAction,
  resourceId: string,
): IdentityDecision {
  const applies = (statement: IamRole['statements'][number]) =>
    statement.actions.includes(action) &&
    (statement.resource === '*' || statement.resource === resourceId)

  const denyIndex = role.statements.findIndex((s) => s.effect === 'deny' && applies(s))
  if (denyIndex >= 0) return { verdict: 'explicit-deny', index: denyIndex }

  const allowIndex = role.statements.findIndex((s) => s.effect === 'allow' && applies(s))
  if (allowIndex >= 0) return { verdict: 'allow', index: allowIndex }

  return { verdict: 'no-match' }
}
