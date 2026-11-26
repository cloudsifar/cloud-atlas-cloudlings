// Encryption at rest with AWS KMS (docs/ENGINE.md, section 17; ADR 0018).
//
// AWS documentation this file is based on:
// - SSE-KMS: storing an object needs kms:GenerateDataKey on the key, reading one needs
//   kms:Decrypt; with the AWS managed key aws/s3 or a customer managed key.
//   https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html
// - Changing a bucket's default encryption to SSE-KMS does not change the encryption of
//   the objects already in it; every new object is encrypted (SSE-S3 by default) since
//   5 January 2023.
//   https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html
//   https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html
// - The default key policy gives the account full access and so lets IAM policies
//   allow use of the key; an IAM deny is effective either way.
//   https://docs.aws.amazon.com/kms/latest/developerguide/key-policy-default.html
// - The AWS managed key for S3 lets every principal in the account that is authorised
//   to use S3 use it through S3 (kms:ViaService, kms:CallerAccount).
//   https://docs.aws.amazon.com/kms/latest/developerguide/conditions-kms.html
// - RDS: encryption can be enabled only when a DB instance is created; an encrypted
//   copy comes from copying a snapshot with encryption on and restoring it.
//   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html
//   https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/encrypt-an-existing-amazon-rds-for-postgresql-db-instance.html

import { describe, expect, it } from 'vitest'
import {
  coinsFor,
  evaluateFlow,
  evaluatePredicate,
  failingStep,
  scoreScene,
  validateScene,
  type BucketEncryption,
  type FlowRun,
  type KmsKey,
  type Predicate,
  type RdsDatabase,
  type Scene,
  type ServiceAction,
} from '../../src/engine'
import {
  anonymousBucketRead,
  byId,
  sceneWith,
  uploadRequest,
  webRequest,
  workingScene,
} from './fixtures'

const KEY: KmsKey = { kind: 'kms-key', id: 'shop-key', name: 'shop-key' }

/** The working scene with a customer managed key, the bucket's default encryption set, and extra role statements. */
function encrypted(
  encryption: BucketEncryption,
  statements: { effect: 'allow' | 'deny'; actions: ServiceAction[]; resource: string }[] = [],
): Scene {
  return sceneWith((scene) => {
    scene.resources.push(structuredClone(KEY))
    const bucket = byId(scene.resources, 'photos')
    if (bucket.kind === 's3-bucket') bucket.encryption = encryption
    const role = byId(scene.resources, 'app-role')
    if (role.kind === 'iam-role') role.statements.push(...statements)
  })
}

const CUSTOMER_KEY: BucketEncryption = { kind: 'sse-kms', keyId: 'shop-key' }
const AWS_MANAGED_KEY: BucketEncryption = { kind: 'sse-kms', keyId: null }
const USE_KEY = { effect: 'allow' as const, actions: ['kms:Use' as const], resource: 'shop-key' }

const kmsSteps = (scene: Scene, flow = uploadRequest()) =>
  evaluateFlow(scene, flow).trace.filter((step) => step.check === 'kms')

describe('SSE-KMS: S3 uses the key as the caller', () => {
  it('needs no key permission for SSE-S3', () => {
    const result = evaluateFlow(workingScene(), uploadRequest())
    expect(result.outcome).toBe('delivered')
    expect(result.trace.some((step) => step.check === 'kms')).toBe(false)
  })

  it('needs no key permission for the AWS managed key aws/s3', () => {
    const scene = encrypted(AWS_MANAGED_KEY)
    expect(evaluateFlow(scene, uploadRequest()).outcome).toBe('delivered')
    const [step] = kmsSteps(scene)
    expect(step?.result).toBe('pass')
    expect(step?.ruleRef).toBe('AWS managed key aws/s3')
  })

  it('stops an upload at the key when the role may not use a customer managed key', () => {
    const scene = encrypted(CUSTOMER_KEY)
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('blocked')
    const failed = failingStep(result)
    expect(failed?.check).toBe('kms')
    expect(failed?.at).toEqual({ kind: 'resource', id: 'photos' })
    expect(failed?.explanation).toContain('kms:GenerateDataKey')
  })

  it('checks the key only after S3 has authorised the caller', () => {
    // Without s3:Write the request fails at IAM, before KMS is ever asked.
    const scene = encrypted(CUSTOMER_KEY, [USE_KEY])
    const role = byId(scene.resources, 'app-role')
    if (role.kind === 'iam-role') role.statements = [USE_KEY]
    const result = evaluateFlow(scene, uploadRequest())
    expect(failingStep(result)?.check).toBe('iam')
    expect(result.trace.some((step) => step.check === 'kms')).toBe(false)
  })

  it('lets the upload through once the role allows kms:Use on the key, and records the statement relied on', () => {
    const scene = encrypted(CUSTOMER_KEY, [USE_KEY])
    expect(evaluateFlow(scene, uploadRequest()).outcome).toBe('delivered')
    const [step] = kmsSteps(scene)
    expect(step?.matched).toEqual({
      kind: 'role-statement',
      roleId: 'app-role',
      index: 1,
      action: 'kms:Use',
      resourceId: 'shop-key',
    })
  })

  it('accepts kms:Use on every resource (*)', () => {
    const scene = encrypted(CUSTOMER_KEY, [{ ...USE_KEY, resource: '*' }])
    expect(evaluateFlow(scene, uploadRequest()).outcome).toBe('delivered')
  })

  it('lets an explicit deny on the key win over an allow', () => {
    const scene = encrypted(CUSTOMER_KEY, [USE_KEY, { ...USE_KEY, effect: 'deny' }])
    const failed = failingStep(evaluateFlow(scene, uploadRequest()))
    expect(failed?.check).toBe('kms')
    expect(failed?.ruleRef).toContain('explicit deny')
  })

  it('needs the key to read an object too (kms:Decrypt)', () => {
    const read = webRequest({ backendCall: { destinationId: 'photos', action: 's3:Read' } })
    const scene = encrypted(CUSTOMER_KEY, [
      { effect: 'allow', actions: ['s3:Read'], resource: 'photos' },
    ])
    const failed = failingStep(evaluateFlow(scene, read))
    expect(failed?.check).toBe('kms')
    expect(failed?.explanation).toContain('kms:Decrypt')
    const allowed = encrypted(CUSTOMER_KEY, [
      { effect: 'allow', actions: ['s3:Read'], resource: 'photos' },
      USE_KEY,
    ])
    expect(evaluateFlow(allowed, read).outcome).toBe('delivered')
  })

  it('does not involve the key in deleting an object', () => {
    const remove = webRequest({ backendCall: { destinationId: 'photos', action: 's3:Delete' } })
    const scene = encrypted(CUSTOMER_KEY, [
      { effect: 'allow', actions: ['s3:Delete'], resource: 'photos' },
    ])
    expect(evaluateFlow(scene, remove).outcome).toBe('delivered')
    expect(kmsSteps(scene, remove)).toEqual([])
  })
})

describe('encryption is not access control', () => {
  const publicBucket = (encryption: BucketEncryption) => {
    const scene = encrypted(encryption, [USE_KEY])
    const bucket = byId(scene.resources, 'photos')
    if (bucket.kind === 's3-bucket') {
      bucket.blockPublicAccess = false
      bucket.policy = [{ effect: 'allow', principal: { kind: 'everyone' }, actions: ['s3:Read'] }]
    }
    return scene
  }

  it('leaves a public bucket readable after switching it to SSE-KMS: stored objects keep SSE-S3', () => {
    const result = evaluateFlow(publicBucket(CUSTOMER_KEY), anonymousBucketRead())
    expect(result.outcome).toBe('breach')
    const read = result.trace.find((step) => step.check === 'bucket-policy')
    expect(read?.explanation).toContain('objects already stored keep the SSE-S3 encryption')
  })

  it('still closes with Block Public Access, whatever the encryption', () => {
    const scene = publicBucket(CUSTOMER_KEY)
    const bucket = byId(scene.resources, 'photos')
    if (bucket.kind === 's3-bucket') bucket.blockPublicAccess = true
    expect(failingStep(evaluateFlow(scene, anonymousBucketRead()))?.check).toBe(
      'block-public-access',
    )
  })
})

describe('RDS encryption at rest', () => {
  const withDatabase = (encryption: RdsDatabase['encryption']): Scene =>
    sceneWith((scene) => {
      scene.resources.push(structuredClone(KEY), {
        kind: 'rds-database',
        id: 'db',
        name: 'orders database',
        engine: 'mysql',
        subnetIds: ['private-a', 'private-b'],
        securityGroupIds: ['sg-db'],
        primarySubnetId: 'private-a',
        multiAz: false,
        status: 'available',
        encryption,
      })
      scene.securityGroups.push({
        id: 'sg-db',
        name: 'rds-db-sg',
        inbound: [{ ports: 'mysql', peer: { kind: 'security-group', securityGroupId: 'sg-app' } }],
        outbound: [{ ports: 'all', peer: { kind: 'anywhere' } }],
      })
    })
  const lookup = webRequest({ backendCall: { destinationId: 'db' } })

  it('answers queries whatever the encryption: RDS uses the key, not the application', () => {
    for (const encryption of [
      { kind: 'none' } as const,
      { kind: 'kms', keyId: null } as const,
      { kind: 'kms', keyId: 'shop-key' } as const,
    ]) {
      const result = evaluateFlow(withDatabase(encryption), lookup)
      expect(result.outcome).toBe('delivered')
      expect(result.trace.some((step) => step.check === 'kms')).toBe(false)
    }
  })

  it('says in the trace how the data is protected at rest', () => {
    const answer = (encryption: RdsDatabase['encryption']) =>
      evaluateFlow(withDatabase(encryption), lookup).trace.find(
        (step) => step.check === 'delivery' && step.at.kind === 'resource' && step.at.id === 'db',
      )?.explanation
    expect(answer({ kind: 'none' })).toContain('not encrypted at rest')
    expect(answer({ kind: 'kms', keyId: null })).toContain('aws/rds')
    expect(answer({ kind: 'kms', keyId: 'shop-key' })).toContain('"shop-key"')
  })

  it('needs the key it names to exist', () => {
    const scene = withDatabase({ kind: 'kms', keyId: 'gone' })
    expect(validateScene(scene).map((problem) => problem.message)).toContain(
      '"orders database" is encrypted with a KMS key that does not exist.',
    )
  })

  it('is what the encryption predicates read', () => {
    const none = withDatabase({ kind: 'none' })
    const awsManaged = withDatabase({ kind: 'kms', keyId: null })
    const customer = withDatabase({ kind: 'kms', keyId: 'shop-key' })
    const encryptedPredicate = { kind: 'database-encrypted', databaseId: 'db' } as const
    expect(evaluatePredicate(none, [], encryptedPredicate)).toBe(false)
    expect(evaluatePredicate(awsManaged, [], encryptedPredicate)).toBe(true)
    expect(evaluatePredicate(customer, [], encryptedPredicate)).toBe(true)

    const oneKey: Predicate = { kind: 'one-customer-key', resourceIds: ['photos', 'db'] }
    const bucketOnKey = (scene: Scene, encryption: BucketEncryption) => {
      const bucket = byId(scene.resources, 'photos')
      if (bucket.kind === 's3-bucket') bucket.encryption = encryption
      return scene
    }
    expect(evaluatePredicate(bucketOnKey(customer, CUSTOMER_KEY), [], oneKey)).toBe(true)
    expect(evaluatePredicate(bucketOnKey(awsManaged, CUSTOMER_KEY), [], oneKey)).toBe(false)
    expect(
      evaluatePredicate(
        bucketOnKey(withDatabase({ kind: 'kms', keyId: 'shop-key' }), AWS_MANAGED_KEY),
        [],
        oneKey,
      ),
    ).toBe(false)
  })
})

describe('bucket encryption predicates and validation', () => {
  const customer = { kind: 'bucket-encrypted-with-customer-key', bucketId: 'photos' } as const
  it('counts only a customer managed key that exists', () => {
    expect(evaluatePredicate(workingScene(), [], customer)).toBe(false)
    expect(evaluatePredicate(encrypted(AWS_MANAGED_KEY), [], customer)).toBe(false)
    expect(evaluatePredicate(encrypted(CUSTOMER_KEY), [], customer)).toBe(true)
  })

  it('reports a bucket encrypted with a key that does not exist', () => {
    const scene = sceneWith((each) => {
      const bucket = byId(each.resources, 'photos')
      if (bucket.kind === 's3-bucket') bucket.encryption = { kind: 'sse-kms', keyId: 'gone' }
    })
    expect(validateScene(scene).some((problem) => problem.severity === 'broken-reference')).toBe(
      true,
    )
  })
})

describe('least privilege for keys', () => {
  const runsOf = (scene: Scene): FlowRun[] =>
    [uploadRequest()].map((flow) => ({ flow, result: evaluateFlow(scene, flow) }))
  const findings = (scene: Scene) =>
    scoreScene(scene, runsOf(scene), []).map((finding) => finding.message)

  it('finds nothing wrong with kms:Use on the one key the uploads rely on', () => {
    expect(findings(encrypted(CUSTOMER_KEY, [USE_KEY]))).toEqual([])
  })

  it('reports kms:Use on every resource', () => {
    expect(findings(encrypted(CUSTOMER_KEY, [{ ...USE_KEY, resource: '*' }]))).toContain(
      'Role "app-role" grants access to every resource (*). Name the one it uses.',
    )
  })

  it('reports kms:Use that nothing needs', () => {
    expect(findings(encrypted({ kind: 'sse-s3' }, [USE_KEY]))).toContain(
      'Role "app-role" allows kms:Use, which the application never uses.',
    )
  })
})

describe('the cost of a key', () => {
  it('is about a dollar a month: one coin', () => {
    expect(coinsFor(KEY)).toBe(1)
  })
})
