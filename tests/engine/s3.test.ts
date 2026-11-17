// Amazon S3 access.
//
// AWS documentation these tests are based on:
// - Blocking public access (overrides policies; the meaning of "public"):
//   https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html
// - Default encryption with SSE-S3 for all new objects since 5 January 2023:
//   https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-encryption-faq.html
// - Policy evaluation with identity and bucket policies in one account:
//   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  failingStep,
  isBucketPublic,
  type BucketPolicyStatement,
  type S3Bucket,
  type Scene,
} from '../../src/engine'
import { anonymousBucketRead, byId, sceneWith, uploadRequest, workingScene } from './fixtures'

const publicRead: BucketPolicyStatement = {
  effect: 'allow',
  principal: { kind: 'everyone' },
  actions: ['s3:Read'],
}

const bucketOf = (scene: Scene): S3Bucket => {
  const bucket = byId(scene.resources, 'photos')
  if (bucket.kind !== 's3-bucket') throw new Error('fixture changed')
  return bucket
}
const withBucket = (change: (bucket: S3Bucket) => void) => sceneWith((s) => change(bucketOf(s)))

describe('Block Public Access', () => {
  it('is on in the default bucket and refuses anonymous requests', () => {
    const result = evaluateFlow(workingScene(), anonymousBucketRead())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('block-public-access')
  })

  it('overrides a bucket policy that grants access to everyone', () => {
    const scene = withBucket((b) => (b.policy = [publicRead]))
    expect(isBucketPublic(bucketOf(scene))).toBe(false)
    expect(failingStep(evaluateFlow(scene, anonymousBucketRead()))?.check).toBe(
      'block-public-access',
    )
  })

  it('does not by itself make a bucket public when switched off', () => {
    const scene = withBucket((b) => (b.blockPublicAccess = false))
    expect(isBucketPublic(bucketOf(scene))).toBe(false)
    const result = evaluateFlow(scene, anonymousBucketRead())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('bucket-policy')
  })
})

describe('public buckets', () => {
  const open = (dataClass: S3Bucket['dataClass']) =>
    withBucket((b) => {
      b.blockPublicAccess = false
      b.policy = [publicRead]
      b.dataClass = dataClass
    })

  it('is public only with Block Public Access off AND a policy granting everyone', () => {
    expect(isBucketPublic(bucketOf(open('sensitive')))).toBe(true)
  })

  it('is a breach when a hostile kite reads a public bucket holding sensitive data', () => {
    expect(evaluateFlow(open('sensitive'), anonymousBucketRead()).outcome).toBe('breach')
  })

  it('is legitimate when the public bucket holds public content, such as a static website', () => {
    expect(evaluateFlow(open('public-content'), anonymousBucketRead()).outcome).toBe('delivered')
    expect(
      evaluateFlow(open('public-content'), anonymousBucketRead({ intent: 'legitimate' })).outcome,
    ).toBe('delivered')
  })

  it('grants only the actions the public statement names', () => {
    const result = evaluateFlow(open('sensitive'), anonymousBucketRead({ action: 's3:Write' }))
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.ruleRef).toBe('implicit deny')
  })
})

describe('roles and bucket policies in one account', () => {
  const stripRole = (scene: Scene) => {
    const role = byId(scene.resources, 'app-role')
    if (role.kind === 'iam-role') role.statements = []
  }

  it('allows access granted by the bucket policy alone', () => {
    const scene = sceneWith((s) => {
      stripRole(s)
      bucketOf(s).policy = [
        { effect: 'allow', principal: { kind: 'role', roleId: 'app-role' }, actions: ['s3:Write'] },
      ]
    })
    expect(evaluateFlow(scene, uploadRequest()).outcome).toBe('delivered')
  })

  it('denies when neither the role nor the bucket policy allows', () => {
    const result = evaluateFlow(sceneWith(stripRole), uploadRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('iam')
  })

  it("lets an explicit deny in the bucket policy override the role's allow", () => {
    const scene = withBucket((b) => {
      b.policy = [
        { effect: 'deny', principal: { kind: 'role', roleId: 'app-role' }, actions: ['s3:Write'] },
      ]
    })
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.ruleRef).toBe('bucket policy: explicit deny')
  })

  it("still serves the account's own role with Block Public Access on", () => {
    // Block Public Access is about the public; it never gets in the way of an authorised role.
    expect(bucketOf(workingScene()).blockPublicAccess).toBe(true)
    expect(evaluateFlow(workingScene(), uploadRequest()).outcome).toBe('delivered')
  })
})

describe('encryption', () => {
  it('models every bucket as encrypted at rest by default (SSE-S3)', () => {
    expect(bucketOf(workingScene()).encryption).toEqual({ kind: 'sse-s3' })
  })
})
