// Databases and Availability Zone failure (ADR 0014).
//
// AWS documentation these rules follow:
// - RDS Multi-AZ DB instance deployments: one standby in another AZ, which does not
//   serve read traffic:
//   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html
// - Failing over a Multi-AZ DB instance: automatic switch to the standby in another
//   AZ; "Failover times are typically 60–120 seconds":
//   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html
// - A DB subnet group needs subnets in at least two Availability Zones:
//   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.WorkingWithRDSInstanceinaVPC.html
// - A DB instance accessed by an EC2 instance in the same VPC, with the database's
//   security group allowing connections from the instance's security group:
//   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_VPC.Scenarios.html
// - When an Availability Zone becomes unhealthy or unavailable, EC2 Auto Scaling
//   launches new instances in an unaffected Availability Zone:
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-add-az-console.html
// - A load balancer stops routing traffic to a target it detects is unhealthy, and has
//   a node in each enabled Availability Zone:
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html
// - With no healthy target, an Application Load Balancer fails open: it routes requests
//   to all registered targets regardless of their health:
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html
// - A NAT Gateway lives in one Availability Zone (brief, Section 7):
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  evaluatePredicate,
  FAILOVER_TICKS,
  failedZonesAt,
  failingStep,
  HEALTH_CHECK_TICKS,
  LAUNCH_TICKS,
  REQUESTS_PER_TICK,
  simulateCrowd,
  validateScene,
  type AutoScalingGroup,
  type CrowdMoment,
  type RdsDatabase,
  type Scene,
} from '../../src/engine'
import { byId, GREEN_IP, sceneWith, webRequest } from './fixtures'

const SMALL = REQUESTS_PER_TICK.small
const FAIL_AT = 3

const database = (overrides: Partial<RdsDatabase> = {}): RdsDatabase => ({
  kind: 'rds-database',
  id: 'db',
  name: 'orders database',
  engine: 'mysql',
  subnetIds: ['private-a', 'private-b'],
  securityGroupIds: ['sg-db'],
  primarySubnetId: 'private-a',
  multiAz: false,
  status: 'available',
  ...overrides,
})

const group = (overrides: Partial<AutoScalingGroup> = {}): AutoScalingGroup => ({
  kind: 'auto-scaling-group',
  id: 'asg',
  name: 'web fleet',
  subnetIds: ['private-a', 'private-b'],
  securityGroupIds: ['sg-app'],
  roleId: null,
  size: 'small',
  min: 2,
  desired: 2,
  max: 8,
  scaling: null,
  ...overrides,
})

type DbPeer = { kind: 'security-group'; securityGroupId: string } | { kind: 'cidr'; cidr: string }

/**
 * The fixture's three tiers with a database behind the app tier, the fixed instances
 * replaced by a group, and the database's security group allowing MySQL from `peer`.
 */
const stormScene = (
  options: {
    group?: Partial<AutoScalingGroup>
    database?: Partial<RdsDatabase>
    peer?: DbPeer
  } = {},
): Scene =>
  sceneWith((scene) => {
    scene.resources = scene.resources.filter((resource) => resource.kind !== 'ec2-instance')
    scene.resources.push(group(options.group), database(options.database))
    const loadBalancer = byId(scene.resources, 'alb')
    if (loadBalancer.kind === 'load-balancer') loadBalancer.targetIds = ['asg']
    scene.securityGroups.push({
      id: 'sg-db',
      name: 'db-sg',
      inbound: [
        {
          ports: 'mysql',
          peer: options.peer ?? { kind: 'security-group', securityGroupId: 'sg-app' },
        },
      ],
      outbound: [{ ports: 'all', peer: { kind: 'anywhere' } }],
    })
  })

const CROWD = { loadBalancerId: 'alb', ip: GREEN_IP, backendCall: { destinationId: 'db' } }

/** A steady crowd of `kites` for `ticks` ticks, with zone a down from FAIL_AT. */
const stormDay = (ticks: number, kites: number): CrowdMoment[] =>
  Array.from({ length: ticks }, (_, tick) => ({
    kites,
    surge: false,
    ...(tick >= FAIL_AT ? { failedZones: ['a' as const] } : {}),
  }))

const withDatabaseCall = webRequest({ backendCall: { destinationId: 'db' } })

describe('an instance querying its RDS database', () => {
  it('is answered when the database allows MySQL from the app tier’s security group', () => {
    const result = evaluateFlow(stormScene(), withDatabaseCall)
    expect(result.outcome).toBe('delivered')
    const atDatabase = result.trace.filter(
      (step) => step.at.kind === 'resource' && step.at.id === 'db',
    )
    expect(atDatabase.map((step) => step.check)).toEqual(['security-group', 'delivery'])
  })

  it('is turned away by the database’s security group when nothing allows the caller', () => {
    const scene = stormScene({ peer: { kind: 'security-group', securityGroupId: 'sg-alb' } })
    const result = evaluateFlow(scene, withDatabaseCall)
    expect(result.outcome).toBe('blocked')
    const stop = failingStep(result)
    expect(stop?.check).toBe('security-group')
    expect(stop?.at).toEqual({ kind: 'resource', id: 'db' })
  })

  it('an address range lets in only callers inside it: one zone’s range shuts out the other zone', () => {
    // Private subnet A is 10.0.11.0/24, B is 10.0.12.0/24. The group alternates a, b.
    const scene = stormScene({ peer: { kind: 'cidr', cidr: '10.0.11.0/24' } })
    // Turn 0 of the round robin picks the instance in A, turn 1 the one in B.
    expect(evaluateFlow(scene, { ...withDatabaseCall, sequence: 0 }).outcome).toBe('delivered')
    expect(evaluateFlow(scene, { ...withDatabaseCall, sequence: 2 }).outcome).toBe('blocked')
  })

  it('fails, without being blocked, while the database is failing over or down', () => {
    for (const status of ['failing-over', 'unavailable'] as const) {
      const result = evaluateFlow(stormScene({ database: { status } }), withDatabaseCall)
      expect(result.outcome).toBe('dropped')
      expect(failingStep(result)?.check).toBe('delivery')
    }
  })

  it('reaches the primary wherever it now runs: the endpoint follows a failover', () => {
    const scene = stormScene({ database: { multiAz: true, primarySubnetId: 'private-b' } })
    const result = evaluateFlow(scene, withDatabaseCall)
    expect(result.outcome).toBe('delivered')
    const answer = result.trace.find(
      (step) => step.check === 'delivery' && step.at.kind === 'resource' && step.at.id === 'db',
    )
    expect(answer?.explanation).toMatch('AZ b')
  })
})

describe('RDS placement rules', () => {
  it('a DB subnet group must cover at least two Availability Zones', () => {
    const scene = stormScene({ database: { subnetIds: ['private-a'] } })
    expect(
      validateScene(scene).some((problem) => problem.message.includes('two Availability Zones')),
    ).toBe(true)
    expect(validateScene(stormScene())).toEqual([])
  })

  it('a database belongs in private subnets only', () => {
    const scene = stormScene({ database: { subnetIds: ['public-a', 'private-b'] } })
    expect(validateScene(scene).some((problem) => problem.message.includes('private'))).toBe(true)
  })
})

describe('an Availability Zone failure', () => {
  it('is felt from its tick to the end of the run', () => {
    const events = [{ kind: 'az-failure', atTick: 3, zone: 'a' } as const]
    expect(failedZonesAt(events, 2)).toEqual([])
    expect(failedZonesAt(events, 3)).toEqual(['a'])
    expect(failedZonesAt(events, 20)).toEqual(['a'])
  })

  it('takes the load balancer’s node there out of service: kites reach the other node', () => {
    const scene = { ...stormScene(), failedZones: ['a' as const] }
    // Whichever node a kite's turn would pick, it goes through public subnet B.
    for (const sequence of [0, 1, 2, 3]) {
      const result = evaluateFlow(scene, { ...withDatabaseCall, sequence })
      const naclSteps = result.trace.filter((step) => step.check === 'nacl')
      expect(naclSteps[0]?.at).toEqual({ kind: 'subnet', id: 'public-b' })
    }
  })

  it('stops a NAT Gateway in that zone carrying anything', () => {
    // The fixture's private subnets reach S3 through a NAT Gateway in public subnet A.
    const scene: Scene = { ...sceneWith(() => {}), failedZones: ['a'] }
    const result = evaluateFlow(scene, {
      id: 'upload',
      source: { kind: 'resource', id: 'app-b' },
      destination: { kind: 'resource', id: 'photos' },
      port: 443,
      payload: 'clean',
      intent: 'legitimate',
      action: 's3:Write',
    })
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.explanation).toMatch('is down')
  })
})

describe('the crowd through the storm', () => {
  it('the load balancer stops sending kites to instances in the failed zone at once', () => {
    const record = simulateCrowd(stormScene({ database: { multiAz: true } }), CROWD, stormDay(8, 4))
    expect(record.ticks[FAIL_AT - 1]?.targetsInService).toBe(2)
    expect(record.ticks[FAIL_AT]?.targetsInService).toBe(1)
    expect(record.ticks[FAIL_AT]?.serving.every((entry) => entry.zone === 'b')).toBe(true)
  })

  it('the group replaces its lost instances in the zone that is up, after its health checks notice', () => {
    const record = simulateCrowd(
      stormScene({ database: { multiAz: true } }),
      CROWD,
      stormDay(12, 4),
    )
    const zones = (tick: number) => record.ticks[tick]?.fleets[0]?.zones
    expect(zones(FAIL_AT)?.a).toMatchObject({ serving: 0, launching: 0, failed: 1 })
    const replacedAt = FAIL_AT + HEALTH_CHECK_TICKS - 1
    expect(record.ticks[replacedAt]?.fleets[0]?.replaced).toBe(1)
    expect(zones(replacedAt)?.b.launching).toBe(1)
    // Terminated in a, started in b, both recorded where they happened.
    expect(zones(replacedAt)?.a.terminated).toBe(1)
    expect(zones(replacedAt)?.b.started).toBe(1)
    // Serving LAUNCH_TICKS later, both in zone b.
    expect(zones(replacedAt + LAUNCH_TICKS)?.b.serving).toBe(2)
    expect(zones(replacedAt + LAUNCH_TICKS)?.a).toMatchObject({
      serving: 0,
      launching: 0,
      failed: 0,
    })
  })

  it('a group whose only subnets are in the failed zone has nowhere to launch', () => {
    const scene = stormScene({ group: { subnetIds: ['private-a'] }, database: { multiAz: true } })
    const record = simulateCrowd(scene, CROWD, stormDay(12, 4))
    expect(record.ticks.slice(FAIL_AT).every((tick) => tick.targetsInService === 0)).toBe(true)
    expect(record.ticks.slice(FAIL_AT).every((tick) => tick.delivered === 0)).toBe(true)
    expect(record.ticks.at(-1)?.fleets[0]?.zones.a.failed).toBe(2)
  })

  it('with nothing healthy the load balancer fails open, and a target in the failed zone never answers', () => {
    const scene = stormScene({ group: { subnetIds: ['private-a'] }, database: { multiAz: true } })
    const record = simulateCrowd(scene, CROWD, stormDay(8, 4))
    const tick = record.ticks[FAIL_AT + 1]!
    expect(tick.served.outcome).toBe('dropped')
    const selection = tick.served.trace.find((step) => step.check === 'target-selection')
    expect(selection?.result).toBe('pass')
    expect(selection?.ruleRef).toBe('fail open: no healthy targets')
    const stop = failingStep(tick.served)
    expect(stop?.check).toBe('delivery')
    expect(stop?.explanation).toContain('Availability Zone a, which is down')
  })

  it('a Multi-AZ database fails over to its standby in the other zone, in FAILOVER_TICKS', () => {
    const record = simulateCrowd(
      stormScene({ database: { multiAz: true } }),
      CROWD,
      stormDay(10, 4),
    )
    const db = (tick: number) => record.ticks[tick]?.databases[0]
    expect(db(FAIL_AT - 1)).toMatchObject({
      status: 'available',
      primaryZone: 'a',
      standbyZone: 'b',
    })
    for (let tick = FAIL_AT; tick < FAIL_AT + FAILOVER_TICKS; tick += 1) {
      expect(db(tick)?.status).toBe('failing-over')
      // Nothing answers while the failover is under way.
      expect(record.ticks[tick]?.delivered).toBe(0)
    }
    expect(db(FAIL_AT + FAILOVER_TICKS)).toMatchObject({
      status: 'available',
      primaryZone: 'b',
      standbyZone: null,
    })
    expect(record.ticks[FAIL_AT + FAILOVER_TICKS]?.delivered).toBe(4)
    expect(FAILOVER_TICKS).toBe(2) // 60–120 seconds, and a tick is a minute.
  })

  it('a single-AZ database whose zone fails is down for the rest of the run', () => {
    const record = simulateCrowd(stormScene(), CROWD, stormDay(10, 4))
    expect(
      record.ticks.slice(FAIL_AT).every((tick) => tick.databases[0]?.status === 'unavailable'),
    ).toBe(true)
    expect(record.ticks.slice(FAIL_AT).every((tick) => tick.delivered === 0)).toBe(true)
    // The kites are not blocked by a control: the database cannot answer.
    expect(record.ticks[FAIL_AT]?.dropped).toBe(4)
    expect(record.ticks[FAIL_AT]?.blocked).toBe(0)
  })

  it('shares the crowd between targets by room, so a target the database turns away costs its share', () => {
    // Zone a's range only: the instance in B is turned away by the database.
    const scene = stormScene({ peer: { kind: 'cidr', cidr: '10.0.11.0/24' } })
    const [tick] = simulateCrowd(scene, CROWD, stormDay(1, 8)).ticks
    expect(tick?.capacity).toBe(2 * SMALL)
    expect(tick?.delivered).toBe(4)
    expect(tick?.blocked).toBe(4)
    expect(tick?.serving.find((entry) => entry.zone === 'b')?.outcome).toBe('blocked')
    expect(tick?.stopped?.outcome).toBe('blocked')
  })
})

describe('predicates for the storm', () => {
  const day = (scene: Scene) => simulateCrowd(scene, CROWD, stormDay(16, 8))
  const holds = (scene: Scene, predicate: Parameters<typeof evaluatePredicate>[2]) =>
    evaluatePredicate(scene, [], predicate, day(scene))
  const spread = { database: { multiAz: true } }

  it('crowd-answered-at-end: still working at the end of the run', () => {
    expect(holds(stormScene(spread), { kind: 'crowd-answered-at-end' })).toBe(true)
    expect(holds(stormScene(), { kind: 'crowd-answered-at-end' })).toBe(false)
  })

  it('crowd-failures-only-during-failover: static stability, one zone carrying the crowd alone', () => {
    const only = { kind: 'crowd-failures-only-during-failover' } as const
    // Two small instances per zone: zone b alone has room for the eight kites.
    expect(holds(stormScene({ ...spread, group: { min: 4, desired: 4 } }), only)).toBe(true)
    // One per zone: after the failover, zone b's one instance has room for five of
    // the eight until the replacement serves.
    expect(holds(stormScene(spread), only)).toBe(false)
  })

  it('group-spans-zones, database-multi-az and security-group-allows-group read the scene', () => {
    const scene = stormScene(spread)
    expect(
      evaluatePredicate(scene, [], { kind: 'group-spans-zones', groupId: 'asg', zones: 2 }),
    ).toBe(true)
    expect(
      evaluatePredicate(stormScene({ group: { subnetIds: ['private-a'] } }), [], {
        kind: 'group-spans-zones',
        groupId: 'asg',
        zones: 2,
      }),
    ).toBe(false)
    expect(evaluatePredicate(scene, [], { kind: 'database-multi-az', databaseId: 'db' })).toBe(true)
    expect(
      evaluatePredicate(stormScene(), [], { kind: 'database-multi-az', databaseId: 'db' }),
    ).toBe(false)
    const chained = {
      kind: 'security-group-allows-group',
      securityGroupId: 'sg-db',
      ports: 'mysql',
      fromSecurityGroupId: 'sg-app',
    } as const
    expect(evaluatePredicate(scene, [], chained)).toBe(true)
    expect(
      evaluatePredicate(stormScene({ peer: { kind: 'cidr', cidr: '10.0.11.0/24' } }), [], chained),
    ).toBe(false)
  })
})
