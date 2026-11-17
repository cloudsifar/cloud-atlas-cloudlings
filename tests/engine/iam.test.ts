// IAM policy evaluation.
//
// AWS documentation these tests are based on:
// - Policy evaluation logic (implicit deny, explicit deny overrides allow,
//   identity-based and resource-based policies within one account):
//   https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html
// - IAM roles for Amazon EC2 (instance profiles, no long-term keys):
//   https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  evaluateIdentityPolicy,
  failingStep,
  type IamRole,
  type PolicyStatement,
} from '../../src/engine'
import { byId, sceneWith, uploadRequest, workingScene } from './fixtures'

const role = (...statements: PolicyStatement[]): IamRole => ({
  kind: 'iam-role',
  id: 'r',
  name: 'r',
  statements,
})
const allow = (actions: PolicyStatement['actions'], resource: string): PolicyStatement => ({
  effect: 'allow',
  actions,
  resource,
})
const deny = (actions: PolicyStatement['actions'], resource: string): PolicyStatement => ({
  effect: 'deny',
  actions,
  resource,
})

describe('identity policies', () => {
  it('denies by default: a role with no statements may do nothing', () => {
    expect(evaluateIdentityPolicy(role(), 's3:Write', 'photos').verdict).toBe('no-match')
  })

  it('allows an action that a statement names on that resource', () => {
    expect(
      evaluateIdentityPolicy(role(allow(['s3:Write'], 'photos')), 's3:Write', 'photos').verdict,
    ).toBe('allow')
  })

  it('does not stretch an allow to other actions or other resources', () => {
    const writer = role(allow(['s3:Write'], 'photos'))
    expect(evaluateIdentityPolicy(writer, 's3:Read', 'photos').verdict).toBe('no-match')
    expect(evaluateIdentityPolicy(writer, 's3:Write', 'other-bucket').verdict).toBe('no-match')
  })

  it('lets * stand for every resource', () => {
    expect(
      evaluateIdentityPolicy(role(allow(['s3:Write'], '*')), 's3:Write', 'anything').verdict,
    ).toBe('allow')
  })

  it('lets an explicit deny override an allow, whichever comes first', () => {
    const allowThenDeny = role(allow(['s3:Write'], '*'), deny(['s3:Write'], 'photos'))
    const denyThenAllow = role(deny(['s3:Write'], 'photos'), allow(['s3:Write'], '*'))
    expect(evaluateIdentityPolicy(allowThenDeny, 's3:Write', 'photos').verdict).toBe(
      'explicit-deny',
    )
    expect(evaluateIdentityPolicy(denyThenAllow, 's3:Write', 'photos').verdict).toBe(
      'explicit-deny',
    )
    // The deny is scoped to one bucket; elsewhere the allow still applies.
    expect(evaluateIdentityPolicy(allowThenDeny, 's3:Write', 'other-bucket').verdict).toBe('allow')
  })
})

describe('roles on instances', () => {
  it('lets the upload through when the instance role allows s3:Write on the bucket', () => {
    const result = evaluateFlow(workingScene(), uploadRequest())
    expect(result.outcome).toBe('delivered')
    expect(result.trace.find((step) => step.check === 'iam')?.result).toBe('pass')
  })

  it('stops the upload at the IAM check when the instance has no role', () => {
    const scene = sceneWith((s) => {
      const instance = byId(s.resources, 'app-a')
      if (instance.kind === 'ec2-instance') instance.roleId = null
    })
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('blocked')
    const failed = failingStep(result)
    expect(failed?.check).toBe('iam')
    expect(failed?.at).toEqual({ kind: 'resource', id: 'photos' })
    expect(failed?.leg).toBe('backend-request')
  })

  it('stops the upload when the role allows a different action', () => {
    const scene = sceneWith((s) => {
      const appRole = byId(s.resources, 'app-role')
      if (appRole.kind === 'iam-role') appRole.statements = [allow(['s3:Read'], 'photos')]
    })
    expect(failingStep(evaluateFlow(scene, uploadRequest()))?.ruleRef).toBe('implicit deny')
  })
})
