// Objectives (predicates), least-privilege scoring and scene validation.
//
// AWS documentation these tests are based on:
// - Grant least privilege (IAM security best practices):
//   https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html#grant-least-privilege
// - Security group rules referencing another group to chain tiers:
//   https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html
// - NAT gateways must be created in a public subnet for internet access:
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html
// - Load balancer subnets in at least two Availability Zones:
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  evaluatePredicate,
  scoreScene,
  validateScene,
  type Flow,
  type FlowRun,
  type Scene,
} from '../../src/engine'
import {
  anonymousBucketRead,
  byId,
  sceneWith,
  uploadRequest,
  webRequest,
  workingScene,
} from './fixtures'

const flows: Flow[] = [
  uploadRequest({ id: 'g1', sequence: 0 }),
  uploadRequest({ id: 'g2', sequence: 1 }),
  uploadRequest({ id: 'g3', sequence: 2 }),
  uploadRequest({ id: 'g4', sequence: 3 }),
  anonymousBucketRead(),
]
const run = (scene: Scene): FlowRun[] =>
  flows.map((flow) => ({ flow, result: evaluateFlow(scene, flow) }))
const findings = (scene: Scene, locked: string[] = []) =>
  scoreScene(scene, run(scene), locked).map((f) => f.subjectId)

describe('least privilege', () => {
  it('finds nothing to trim in the working scene', () => {
    expect(scoreScene(workingScene(), run(workingScene()), [])).toEqual([])
  })

  it('flags a security group rule no friendly kite needs', () => {
    const scene = sceneWith((s) =>
      byId(s.securityGroups, 'sg-alb').inbound.push({ ports: 'ssh', peer: { kind: 'anywhere' } }),
    )
    expect(findings(scene)).toEqual(['sg-alb'])
  })

  it('flags an address range where a security group reference would do', () => {
    const scene = sceneWith(
      (s) =>
        (byId(s.securityGroups, 'sg-app').inbound = [
          { ports: 'http', peer: { kind: 'anywhere' } },
        ]),
    )
    expect(findings(scene)).toEqual(['sg-app'])
  })

  it('flags "all traffic" where one port is used', () => {
    const scene = sceneWith(
      (s) =>
        (byId(s.securityGroups, 'sg-alb').inbound = [{ ports: 'all', peer: { kind: 'anywhere' } }]),
    )
    expect(findings(scene)).toEqual(['sg-alb'])
  })

  it('flags a role action the application never uses, and a * resource', () => {
    const extraAction = sceneWith((s) => {
      const role = byId(s.resources, 'app-role')
      if (role.kind === 'iam-role') role.statements[0]?.actions.push('s3:Delete')
    })
    expect(findings(extraAction)).toEqual(['app-role'])
    const star = sceneWith((s) => {
      const role = byId(s.resources, 'app-role')
      if (role.kind === 'iam-role')
        role.statements = [{ effect: 'allow', actions: ['s3:Write'], resource: '*' }]
    })
    expect(findings(star)).toEqual(['app-role'])
  })

  it('flags Block Public Access switched off on a sensitive bucket', () => {
    const scene = sceneWith((s) => {
      const bucket = byId(s.resources, 'photos')
      if (bucket.kind === 's3-bucket') bucket.blockPublicAccess = false
    })
    expect(findings(scene)).toEqual(['photos'])
  })

  it('never reports something the player is not allowed to edit', () => {
    const scene = sceneWith(
      (s) =>
        (byId(s.securityGroups, 'sg-app').inbound = [
          { ports: 'http', peer: { kind: 'anywhere' } },
        ]),
    )
    expect(findings(scene, ['sg-app'])).toEqual([])
  })
})

describe('predicates', () => {
  const scene = workingScene()
  const runs = run(scene)

  it('checks deliveries and stops by intent', () => {
    expect(
      evaluatePredicate(scene, runs, { kind: 'flows-delivered', flows: { intent: 'legitimate' } }),
    ).toBe(true)
    expect(
      evaluatePredicate(scene, runs, {
        kind: 'flows-stopped',
        flows: { intent: 'hostile' },
        by: 'block-public-access',
      }),
    ).toBe(true)
    expect(
      evaluatePredicate(scene, runs, {
        kind: 'flows-stopped',
        flows: { intent: 'hostile' },
        by: 'nacl',
      }),
    ).toBe(false)
  })

  it('does not count an empty selection as success', () => {
    expect(
      evaluatePredicate(scene, [], { kind: 'flows-delivered', flows: { intent: 'legitimate' } }),
    ).toBe(false)
  })

  it('does not count a breach as stopped', () => {
    const open = sceneWith((s) => {
      const bucket = byId(s.resources, 'photos')
      if (bucket.kind === 's3-bucket') {
        bucket.blockPublicAccess = false
        bucket.policy = [{ effect: 'allow', principal: { kind: 'everyone' }, actions: ['s3:Read'] }]
      }
    })
    expect(
      evaluatePredicate(open, run(open), { kind: 'flows-stopped', flows: { intent: 'hostile' } }),
    ).toBe(false)
    expect(evaluatePredicate(open, [], { kind: 'bucket-locked-down', bucketId: 'photos' })).toBe(
      false,
    )
  })

  it('checks the structure of the scene', () => {
    const yes = (predicate: Parameters<typeof evaluatePredicate>[2]) =>
      evaluatePredicate(scene, runs, predicate)
    expect(yes({ kind: 'resource-exists', resourceId: 'igw' })).toBe(true)
    expect(
      yes({
        kind: 'route-present',
        routeTableId: 'rt-public',
        destination: 'internet',
        target: 'internet-gateway',
      }),
    ).toBe(true)
    expect(
      yes({
        kind: 'security-group-allows',
        securityGroupId: 'sg-alb',
        ports: 'https',
        peer: { kind: 'anywhere' },
      }),
    ).toBe(true)
    expect(yes({ kind: 'listener-is', loadBalancerId: 'alb', listener: 'https' })).toBe(true)
    expect(yes({ kind: 'targets-registered', loadBalancerId: 'alb', atLeast: 2 })).toBe(true)
    expect(yes({ kind: 'targets-in-both-azs', loadBalancerId: 'alb' })).toBe(true)
    expect(yes({ kind: 'targets-accept-only-load-balancer', loadBalancerId: 'alb' })).toBe(true)
    expect(yes({ kind: 'role-attached', instanceIds: ['app-a', 'app-b'] })).toBe(true)
    expect(
      yes({ kind: 'role-allows', roleId: 'app-role', action: 's3:Write', resourceId: 'photos' }),
    ).toBe(true)
    expect(yes({ kind: 'bucket-locked-down', bucketId: 'photos' })).toBe(true)
    expect(
      yes({ kind: 'role-allows', roleId: 'app-role', action: 's3:Read', resourceId: 'photos' }),
    ).toBe(false)
  })

  it('notices targets that accept more than the load balancer', () => {
    const open = sceneWith((s) =>
      byId(s.securityGroups, 'sg-app').inbound.push({ ports: 'http', peer: { kind: 'anywhere' } }),
    )
    expect(
      evaluatePredicate(open, [], {
        kind: 'targets-accept-only-load-balancer',
        loadBalancerId: 'alb',
      }),
    ).toBe(false)
  })
})

describe('validateScene', () => {
  it('finds no problems in the working scene', () => {
    expect(validateScene(workingScene())).toEqual([])
  })

  it('reports a NAT Gateway outside a public subnet', () => {
    const scene = sceneWith((s) => {
      const nat = byId(s.resources, 'nat')
      if (nat.kind === 'nat-gateway') nat.subnetId = 'private-a'
    })
    expect(validateScene(scene).map((p) => [p.severity, p.subjectId])).toEqual([
      ['misconfiguration', 'nat'],
    ])
  })

  it('reports a load balancer in fewer than two Availability Zones', () => {
    const scene = sceneWith((s) => {
      const alb = byId(s.resources, 'alb')
      if (alb.kind === 'load-balancer') alb.subnetIds = ['public-a']
    })
    expect(validateScene(scene).map((p) => p.subjectId)).toEqual(['alb'])
  })

  it('reports references to things that do not exist', () => {
    const scene = sceneWith((s) => (byId(s.subnets, 'private-a').routeTableId = 'missing'))
    expect(validateScene(scene)[0]?.severity).toBe('broken-reference')
  })

  it('still evaluates a web request in a scene with no problems', () => {
    expect(evaluateFlow(workingScene(), webRequest()).outcome).toBe('delivered')
  })
})
