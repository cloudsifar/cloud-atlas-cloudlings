// Amazon S3 access decisions: identity policy + bucket policy + Block Public Access.

import { evaluateIdentityPolicy } from './iam'
import type { BucketPolicyStatement, IamRole, S3Bucket, ServiceAction } from './model'
import type { CheckKind, CheckOutcome } from './trace'

/** Who is asking. Nobody in the game holds access keys, so a caller is a role or anonymous. */
export type Caller =
  | { kind: 'anonymous' }
  | { kind: 'role'; role: IamRole }
  /** An instance with no role attached has no credentials at all. */
  | { kind: 'no-credentials'; description: string }

export type BucketAccessDecision = CheckOutcome & { check: CheckKind }

/**
 * AWS behaviour modelled: a bucket is public only if Block Public Access is off
 * AND its policy grants access to everyone.
 */
export function isBucketPublic(bucket: S3Bucket): boolean {
  return !bucket.blockPublicAccess && hasPublicStatement(bucket)
}

export function hasPublicStatement(bucket: S3Bucket): boolean {
  return bucket.policy.some((s) => s.effect === 'allow' && s.principal.kind === 'everyone')
}

function findStatement(
  bucket: S3Bucket,
  effect: 'allow' | 'deny',
  action: ServiceAction,
  principalMatches: (principal: BucketPolicyStatement['principal']) => boolean,
): number {
  return bucket.policy.findIndex(
    (s) => s.effect === effect && s.actions.includes(action) && principalMatches(s.principal),
  )
}

/**
 * AWS behaviour modelled, in the order AWS evaluates it:
 *  1. An explicit deny in any applicable policy wins.
 *  2. Anonymous callers: Block Public Access, when on, overrides any policy that
 *     grants access to everyone. With it off, only a public policy statement grants access.
 *  3. Roles in the same account: an allow in the role's identity policy OR in the
 *     bucket policy is enough.
 *  4. Otherwise the request is implicitly denied.
 */
export function evaluateBucketAccess(
  bucket: S3Bucket,
  caller: Caller,
  action: ServiceAction,
): BucketAccessDecision {
  if (caller.kind === 'no-credentials') {
    return {
      check: 'iam',
      result: 'fail',
      ruleRef: 'no IAM role attached',
      explanation: `${caller.description} has no IAM role, so it has no credentials to sign the request. S3 refuses it.`,
    }
  }

  if (caller.kind === 'anonymous') {
    if (bucket.blockPublicAccess) {
      return {
        check: 'block-public-access',
        result: 'fail',
        ruleRef: 'Block Public Access: on',
        explanation: `Block Public Access is on for "${bucket.name}". It overrides any policy that would open the bucket to everyone, so an anonymous request is refused.`,
      }
    }
    const everyone = (principal: BucketPolicyStatement['principal']) => principal.kind === 'everyone'
    if (findStatement(bucket, 'deny', action, everyone) >= 0) {
      return {
        check: 'bucket-policy',
        result: 'fail',
        ruleRef: 'bucket policy: explicit deny',
        explanation: `The bucket policy of "${bucket.name}" explicitly denies ${action} to everyone.`,
      }
    }
    const allowIndex = findStatement(bucket, 'allow', action, everyone)
    if (allowIndex >= 0) {
      return {
        check: 'bucket-policy',
        result: 'pass',
        ruleRef: `bucket policy: allow ${action} to everyone`,
        matched: { kind: 'bucket-statement', bucketId: bucket.id, index: allowIndex, action },
        explanation: `Block Public Access is off and the bucket policy of "${bucket.name}" allows ${action} to everyone, so anyone on the internet may do this.`,
      }
    }
    return {
      check: 'bucket-policy',
      result: 'fail',
      ruleRef: 'implicit deny',
      explanation: `Nothing in the bucket policy of "${bucket.name}" allows ${action} to everyone, so an anonymous request is denied by default.`,
    }
  }

  const role = caller.role
  // A bucket statement applies to this role if it names the role or names everyone.
  // (With Block Public Access on, a public statement still covers principals inside
  // the bucket owner's own account; it is anonymous and cross-account callers that are cut off.)
  const coversRole = (principal: BucketPolicyStatement['principal']) =>
    principal.kind === 'everyone' || principal.roleId === role.id

  const identity = evaluateIdentityPolicy(role, action, bucket.id)
  if (identity.verdict === 'explicit-deny') {
    return {
      check: 'iam',
      result: 'fail',
      ruleRef: `role "${role.name}": explicit deny`,
      explanation: `Role "${role.name}" has a statement that explicitly denies ${action} on "${bucket.name}". An explicit deny overrides every allow.`,
    }
  }
  if (findStatement(bucket, 'deny', action, coversRole) >= 0) {
    return {
      check: 'iam',
      result: 'fail',
      ruleRef: 'bucket policy: explicit deny',
      explanation: `The bucket policy of "${bucket.name}" explicitly denies ${action}. An explicit deny overrides every allow.`,
    }
  }
  if (identity.verdict === 'allow') {
    return {
      check: 'iam',
      result: 'pass',
      ruleRef: `role "${role.name}": allow ${action}`,
      matched: { kind: 'role-statement', roleId: role.id, index: identity.index, action, resourceId: bucket.id },
      explanation: `Role "${role.name}" allows ${action} on "${bucket.name}".`,
    }
  }
  const bucketAllowIndex = findStatement(bucket, 'allow', action, coversRole)
  if (bucketAllowIndex >= 0) {
    return {
      check: 'iam',
      result: 'pass',
      ruleRef: `bucket policy: allow ${action}`,
      matched: { kind: 'bucket-statement', bucketId: bucket.id, index: bucketAllowIndex, action },
      explanation: `The bucket policy of "${bucket.name}" allows ${action} for this role. Within one account, an allow from the bucket policy is enough.`,
    }
  }
  return {
    check: 'iam',
    result: 'fail',
    ruleRef: 'implicit deny',
    explanation: `Neither role "${role.name}" nor the bucket policy allows ${action} on "${bucket.name}". IAM denies anything that is not explicitly allowed.`,
  }
}
