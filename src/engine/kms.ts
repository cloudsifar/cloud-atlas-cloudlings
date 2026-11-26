// AWS KMS: may this caller use the key that protects the data?
//
// AWS behaviour modelled (docs/ENGINE.md, section 17):
// - SSE-S3 needs no KMS permission at all: S3 manages those keys itself.
// - SSE-KMS with the AWS managed key aws/s3: its key policy lets every principal in the
//   account use it through S3, so a caller S3 has authorised needs nothing more.
// - SSE-KMS with a customer managed key: S3 calls KMS on the caller's behalf, as the
//   caller. Uploading an object needs kms:GenerateDataKey on the key, and reading one
//   needs kms:Decrypt (the game's kms:Use covers both). A key created with the default
//   key policy lets IAM policies in the account decide, so the caller's role must allow
//   it; an explicit deny there still wins.
// - Encryption at rest on RDS is the database's business: it uses the key itself, and
//   the application connecting to it needs no KMS permission.

import { evaluateIdentityPolicy } from './iam'
import {
  findResourceOfKind,
  type IamRole,
  type S3Bucket,
  type Scene,
  type ServiceAction,
} from './model'
import type { CheckOutcome } from './trace'

/** What S3 asks KMS for, on the caller's behalf, for each action that touches object data. */
const KMS_OPERATION: Partial<Record<ServiceAction, string>> = {
  's3:Write': 'kms:GenerateDataKey',
  's3:Read': 'kms:Decrypt',
}

/** Whether this action on this bucket involves a KMS key at all. */
export function needsKeyCheck(bucket: S3Bucket, action: ServiceAction): boolean {
  return bucket.encryption.kind === 'sse-kms' && KMS_OPERATION[action] !== undefined
}

/**
 * The KMS check for a role reading or writing objects in a bucket whose default
 * encryption is SSE-KMS. Call only when `needsKeyCheck` is true.
 */
export function evaluateKeyUse(
  scene: Scene,
  bucket: S3Bucket,
  role: IamRole,
  action: ServiceAction,
): CheckOutcome {
  const operation = KMS_OPERATION[action] ?? 'kms:Decrypt'
  const encryption = bucket.encryption
  const keyId = encryption.kind === 'sse-kms' ? encryption.keyId : null
  if (keyId === null) {
    return {
      result: 'pass',
      ruleRef: 'AWS managed key aws/s3',
      explanation: `"${bucket.name}" encrypts objects with the AWS managed key aws/s3. Its key policy lets anyone in the account use it through S3, so role "${role.name}" needs no KMS permission of its own.`,
    }
  }
  const key = findResourceOfKind(scene, 'kms-key', keyId)
  if (!key) {
    return {
      result: 'fail',
      ruleRef: 'KMS key missing',
      explanation: `"${bucket.name}" encrypts objects with a KMS key that no longer exists, so nobody can encrypt or decrypt them.`,
    }
  }
  const verb = action === 's3:Write' ? 'encrypt the upload' : 'decrypt the object'
  const identity = evaluateIdentityPolicy(role, 'kms:Use', key.id)
  if (identity.verdict === 'explicit-deny') {
    return {
      result: 'fail',
      ruleRef: `role "${role.name}": explicit deny kms:Use`,
      explanation: `To ${verb}, S3 asks KMS (${operation}) to use "${key.name}" as role "${role.name}". The role explicitly denies kms:Use on it, and an explicit deny overrides every allow.`,
    }
  }
  if (identity.verdict === 'allow') {
    return {
      result: 'pass',
      ruleRef: `role "${role.name}": allow kms:Use`,
      matched: {
        kind: 'role-statement',
        roleId: role.id,
        index: identity.index,
        action: 'kms:Use',
        resourceId: key.id,
      },
      explanation: `To ${verb}, S3 asks KMS (${operation}) to use the customer managed key "${key.name}" as role "${role.name}". The key's policy leaves it to IAM, and the role allows kms:Use on it.`,
    }
  }
  return {
    result: 'fail',
    ruleRef: 'implicit deny: no kms:Use',
    explanation: `To ${verb}, S3 asks KMS (${operation}) to use the customer managed key "${key.name}" as role "${role.name}". The key's default policy leaves the decision to IAM, and the role does not allow kms:Use on "${key.name}", so KMS refuses and S3 cannot ${action === 's3:Write' ? 'store' : 'return'} it.`,
  }
}
