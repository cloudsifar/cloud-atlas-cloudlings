// Auto Scaling groups, capacity and crowds.
//
// AWS behaviour these rest on:
// - Auto Scaling groups (min, desired, max; balancing across Availability Zones):
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html
// - Attaching a load balancer registers the group's instances as targets:
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html
// - Target tracking scaling policies (CloudWatch alarms created for you; scales out
//   in proportion to the metric, scales in more gradually):
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html
// - Dynamic scaling overview:
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scale-based-on-demand.html
//
// Capacity per instance and launch time are illustrative numbers (see
// docs/SIMPLIFICATIONS.md). These tests pin the behaviour, not the numbers.

import { describe, expect, it } from 'vitest'
import {
  costOfScene,
  evaluateFlow,
  evaluatePredicate,
  expandAutoScalingGroups,
  groupInstances,
  healthyTargets,
  LAUNCH_TICKS,
  REQUESTS_PER_TICK,
  simulateCrowd,
  type AutoScalingGroup,
  type Crowd,
  type Scene,
} from '../../src/engine'
import { byId, GREEN_IP, sceneWith, webRequest, workingScene } from './fixtures'

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

/** The working scene with its two fixed instances replaced by a group behind the load balancer. */
const sceneWithGroup = (overrides: Partial<AutoScalingGroup> = {}): Scene =>
  sceneWith((scene) => {
    scene.resources = scene.resources.filter((resource) => resource.kind !== 'ec2-instance')
    scene.resources.push(group(overrides))
    const loadBalancer = byId(scene.resources, 'alb')
    if (loadBalancer.kind === 'load-balancer') loadBalancer.targetIds = ['asg']
  })

const crowd = (...phases: [ticks: number, kitesPerTick: number][]): Crowd => ({
  loadBalancerId: 'alb',
  ip: GREEN_IP,
  phases: phases.map(([ticks, kitesPerTick]) => ({ ticks, kitesPerTick })),
})

const SMALL = REQUESTS_PER_TICK.small

describe('group instances', () => {
  it('runs `desired` instances, spread evenly across its subnets', () => {
    const instances = groupInstances(group({ desired: 4 }))
    expect(instances).toHaveLength(4)
    expect(instances.filter((instance) => instance.subnetId === 'private-a')).toHaveLength(2)
    expect(instances.filter((instance) => instance.subnetId === 'private-b')).toHaveLength(2)
  })

  it('never runs fewer than min or more than max, whatever desired says', () => {
    expect(groupInstances(group({ min: 2, desired: 0, max: 8 }))).toHaveLength(2)
    expect(groupInstances(group({ min: 2, desired: 20, max: 8 }))).toHaveLength(8)
  })

  it('gives every instance the group’s size, security groups and role', () => {
    const [first] = groupInstances(group({ size: 'medium', roleId: 'app-role' }))
    expect(first?.size).toBe('medium')
    expect(first?.securityGroupIds).toEqual(['sg-app'])
    expect(first?.roleId).toBe('app-role')
  })

  it('registers its instances with a load balancer that targets the group', () => {
    const scene = sceneWithGroup({ desired: 3 })
    expect(healthyTargets(scene, 'alb')).toHaveLength(3)
    const loadBalancer = byId(expandAutoScalingGroups(scene).resources, 'alb')
    expect(loadBalancer.kind === 'load-balancer' && loadBalancer.targetIds).toHaveLength(3)
  })

  it('expanding twice changes nothing', () => {
    const once = expandAutoScalingGroups(sceneWithGroup())
    expect(expandAutoScalingGroups(once)).toEqual(once)
  })

  it('serves a kite exactly as fixed instances would, through the same checks', () => {
    const fixed = evaluateFlow(workingScene(), webRequest())
    const grouped = evaluateFlow(sceneWithGroup(), webRequest())
    expect(grouped.outcome).toBe('delivered')
    expect(grouped.trace.map((step) => step.check)).toEqual(fixed.trace.map((step) => step.check))
  })

  it('is charged for the instances it runs, not for the group', () => {
    const two = costOfScene(sceneWithGroup({ desired: 2 })).total
    const four = costOfScene(sceneWithGroup({ desired: 4 })).total
    expect(four).toBeGreaterThan(two)
    expect(two).toBe(costOfScene(workingScene()).total)
  })
})

describe('capacity', () => {
  it('delivers everything while demand is within capacity', () => {
    const record = simulateCrowd(workingScene(), crowd([3, 2 * SMALL]))
    expect(record.deliveredPercent).toBe(100)
    expect(record.ticks.every((tick) => tick.dropped === 0)).toBe(true)
  })

  it('drops the requests beyond total healthy capacity, and no others', () => {
    const record = simulateCrowd(workingScene(), crowd([1, 2 * SMALL + 7]))
    expect(record.ticks[0]?.delivered).toBe(2 * SMALL)
    expect(record.ticks[0]?.dropped).toBe(7)
    expect(record.ticks[0]?.cpuPercent).toBe(100)
  })

  it('counts only healthy targets as capacity', () => {
    const scene = sceneWith((draft) => {
      const instance = byId(draft.resources, 'app-a')
      if (instance.kind === 'ec2-instance') instance.healthy = false
    })
    const record = simulateCrowd(scene, crowd([1, 2 * SMALL]))
    expect(record.ticks[0]?.targetsInService).toBe(1)
    expect(record.ticks[0]?.delivered).toBe(SMALL)
  })

  it('a larger instance serves more', () => {
    expect(REQUESTS_PER_TICK.medium).toBeGreaterThan(REQUESTS_PER_TICK.small)
    expect(REQUESTS_PER_TICK.large).toBeGreaterThan(REQUESTS_PER_TICK.medium)
  })

  it('reports a misconfiguration as blocked, not as a capacity problem', () => {
    const scene = sceneWith((draft) => (byId(draft.securityGroups, 'sg-alb').inbound = []))
    const record = simulateCrowd(scene, crowd([2, 4]))
    expect(record.delivered).toBe(0)
    expect(record.ticks.every((tick) => tick.blocked === 4 && tick.dropped === 0)).toBe(true)
  })

  it('is deterministic', () => {
    const run = () =>
      simulateCrowd(
        sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
        crowd([2, 4], [8, 40], [6, 4]),
      )
    expect(run()).toEqual(run())
  })
})

describe('target tracking scaling', () => {
  const surge = crowd([2, 4], [10, 40], [12, 4])

  it('does nothing without a scaling policy: the group stays at its size', () => {
    const record = simulateCrowd(sceneWithGroup(), surge)
    expect(record.peakTargetsInService).toBe(2)
    expect(record.deliveredPercent < 60).toBe(true)
  })

  it('scales out when CPU is above the target, and the new instances serve only after launching', () => {
    const record = simulateCrowd(sceneWithGroup({ scaling: { targetCpuPercent: 50 } }), surge)
    const firstBusyTick = 2
    expect(record.ticks[firstBusyTick]?.alarm).toBe('high-cpu')
    expect(record.ticks[firstBusyTick]?.launching).toBeGreaterThan(0)
    // Nothing new is in service until the launch time has passed.
    for (let tick = firstBusyTick; tick < firstBusyTick + LAUNCH_TICKS; tick += 1) {
      expect(record.ticks[tick]?.targetsInService).toBe(2)
    }
    expect(record.ticks[firstBusyTick + LAUNCH_TICKS]?.targetsInService).toBeGreaterThan(2)
  })

  it('scales out in proportion: further above the target means more instances at once', () => {
    const gentle = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      crowd([1, 6]),
    )
    const steep = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      crowd([1, 40]),
    )
    expect(gentle.ticks[0]?.launching).toBe(1)
    expect(steep.ticks[0]?.launching).toBeGreaterThan(1)
  })

  it('never exceeds max', () => {
    const record = simulateCrowd(
      sceneWithGroup({ max: 3, scaling: { targetCpuPercent: 50 } }),
      surge,
    )
    expect(record.peakTargetsInService).toBe(3)
  })

  it('scales in gradually, one instance per tick, once the crowd has gone', () => {
    const record = simulateCrowd(sceneWithGroup({ scaling: { targetCpuPercent: 50 } }), surge)
    const afterSurge = record.ticks.slice(12).map((tick) => tick.targetsInService)
    for (let index = 1; index < afterSurge.length; index += 1) {
      const change = afterSurge[index - 1]! - afterSurge[index]!
      expect(change === 0 || change === 1).toBe(true)
    }
    expect(record.finalTargetsInService < record.peakTargetsInService).toBe(true)
  })

  it('never goes below min', () => {
    const record = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      crowd([20, 0]),
    )
    expect(record.finalTargetsInService).toBe(2)
  })

  it('does not scale in if that would push CPU back over the target', () => {
    // Three instances at 60%: two would run at 90%, well over a 70% target.
    const scene = sceneWithGroup({ desired: 3, scaling: { targetCpuPercent: 70 } })
    const record = simulateCrowd(scene, crowd([6, 9]))
    expect(record.finalTargetsInService).toBe(3)
    expect(record.ticks.every((tick) => tick.alarm === 'ok')).toBe(true)
  })

  it('a lower CPU target keeps more headroom, so fewer kites are dropped', () => {
    const at80 = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 80 } }),
      crowd([2, 4], [2, 12], [2, 24], [10, 40]),
    )
    const at40 = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 40 } }),
      crowd([2, 4], [2, 12], [2, 24], [10, 40]),
    )
    expect(at40.delivered).toBeGreaterThan(at80.delivered)
  })
})

describe('crowd predicates', () => {
  const surge = crowd([2, 4], [10, 40], [12, 4])

  it('are false when the level has no crowd record', () => {
    expect(
      evaluatePredicate(workingScene(), [], { kind: 'crowd-delivered-at-least', percent: 0 }),
    ).toBe(false)
    expect(evaluatePredicate(workingScene(), [], { kind: 'crowd-scaled-out-and-back-in' })).toBe(
      false,
    )
  })

  it('crowd-delivered-at-least compares against the whole crowd', () => {
    const scene = workingScene()
    const record = simulateCrowd(scene, crowd([1, 2 * SMALL], [1, 4 * SMALL]))
    // 10 of 10, then 10 of 20: 20 of 30 delivered, which is 66%.
    expect(record.deliveredPercent).toBe(66)
    expect(
      evaluatePredicate(scene, [], { kind: 'crowd-delivered-at-least', percent: 66 }, record),
    ).toBe(true)
    expect(
      evaluatePredicate(scene, [], { kind: 'crowd-delivered-at-least', percent: 67 }, record),
    ).toBe(false)
  })

  it('crowd-scaled-out-and-back-in needs capacity to have grown and then shrunk', () => {
    const fixed = workingScene()
    expect(
      evaluatePredicate(
        fixed,
        [],
        { kind: 'crowd-scaled-out-and-back-in' },
        simulateCrowd(fixed, surge),
      ),
    ).toBe(false)
    const scaled = sceneWithGroup({ scaling: { targetCpuPercent: 50 } })
    expect(
      evaluatePredicate(
        scaled,
        [],
        { kind: 'crowd-scaled-out-and-back-in' },
        simulateCrowd(scaled, surge),
      ),
    ).toBe(true)
  })
})
