// Auto Scaling groups, capacity and crowds.
//
// AWS behaviour these rest on:
// - Auto Scaling groups (min, desired, max; balancing across Availability Zones):
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-groups.html
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/auto-scaling-benefits.html
// - Desired capacity lies between the minimum and the maximum, and is the capacity
//   the group starts at and tries to keep:
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-capacity-limits.html
// - A target too busy to answer before the load balancer's idle timeout gives the
//   client HTTP 504; the remedy is more targets:
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html
// - Attaching a load balancer registers the group's instances as targets:
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/autoscaling-load-balancer.html
// - Target tracking scaling policies (CloudWatch alarms created for you; scales out
//   in proportion to the metric, scales in more gradually; "scale out ... when CPU
//   exceeds 50 percent", "scale in ... when CPU drops below 50 percent"):
//   https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html
//   and the same policy for Spot Fleet, which states it plainly: "scales out
//   proportionally to the metric as fast as it can, but scales in more gradually":
//   https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-fleet-target-tracking.html
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
  SCALE_IN_TICKS,
  simulateCrowd,
  validateScene,
  failingStep,
  type AutoScalingGroup,
  type CrowdMoment,
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

/** The crowd heads for the fixture's load balancer from one documentation address. */
const CROWD = { loadBalancerId: 'alb', ip: GREEN_IP }

/** A timeline built from [ticks, kitesPerTick] phases, e.g. timeline([2, 4], [10, 40]). */
const timeline = (...phases: [ticks: number, kitesPerTick: number][]): CrowdMoment[] =>
  phases.flatMap(([ticks, kites]) => Array.from({ length: ticks }, () => ({ kites, surge: false })))

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

  it('starts at its desired capacity, not its minimum', () => {
    const record = simulateCrowd(
      sceneWithGroup({ min: 2, desired: 5, max: 8 }),
      CROWD,
      timeline([1, 4]),
    )
    expect(record.ticks[0]?.targetsInService).toBe(5)
  })

  it('is reported as broken unless minimum ≤ desired ≤ maximum', () => {
    const problems = (overrides: Partial<AutoScalingGroup>) =>
      validateScene(sceneWithGroup(overrides)).filter((problem) => problem.subjectId === 'asg')
    expect(problems({ min: 2, desired: 2, max: 8 })).toEqual([])
    expect(problems({ min: 3, desired: 2, max: 8 })).toHaveLength(1)
    expect(problems({ min: 2, desired: 9, max: 8 })).toHaveLength(1)
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
    const record = simulateCrowd(workingScene(), CROWD, timeline([3, 2 * SMALL]))
    expect(record.deliveredPercent).toBe(100)
    expect(record.ticks.every((tick) => tick.dropped === 0)).toBe(true)
  })

  it('drops the requests beyond total healthy capacity, and no others', () => {
    const record = simulateCrowd(workingScene(), CROWD, timeline([1, 2 * SMALL + 7]))
    expect(record.ticks[0]?.delivered).toBe(2 * SMALL)
    expect(record.ticks[0]?.dropped).toBe(7)
    expect(record.ticks[0]?.cpuPercent).toBe(100)
  })

  it('counts only healthy targets as capacity', () => {
    const scene = sceneWith((draft) => {
      const instance = byId(draft.resources, 'app-a')
      if (instance.kind === 'ec2-instance') instance.healthy = false
    })
    const record = simulateCrowd(scene, CROWD, timeline([1, 2 * SMALL]))
    expect(record.ticks[0]?.targetsInService).toBe(1)
    expect(record.ticks[0]?.delivered).toBe(SMALL)
  })

  it('a larger instance serves more', () => {
    expect(REQUESTS_PER_TICK.medium).toBeGreaterThan(REQUESTS_PER_TICK.small)
    expect(REQUESTS_PER_TICK.large).toBeGreaterThan(REQUESTS_PER_TICK.medium)
  })

  it('reports a misconfiguration as blocked, not as a capacity problem', () => {
    const scene = sceneWith((draft) => (byId(draft.securityGroups, 'sg-alb').inbound = []))
    const record = simulateCrowd(scene, CROWD, timeline([2, 4]))
    expect(record.delivered).toBe(0)
    expect(record.ticks.every((tick) => tick.blocked === 4 && tick.dropped === 0)).toBe(true)
  })

  it('is deterministic', () => {
    const run = () =>
      simulateCrowd(
        sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
        CROWD,
        timeline([2, 4], [8, 40], [6, 4]),
      )
    expect(run()).toEqual(run())
  })
})

describe('what each tick records', () => {
  it('the room the targets have, which clouds they are, and the Availability Zones they span', () => {
    const [tick] = simulateCrowd(workingScene(), CROWD, timeline([1, 4])).ticks
    expect(tick?.capacity).toBe(2 * SMALL)
    expect(tick?.zonesInService).toBe(2)
    expect(tick?.serving).toEqual([
      { resourceId: 'app-a', instances: 1, capacity: SMALL },
      { resourceId: 'app-b', instances: 1, capacity: SMALL },
    ])
  })

  it('counts a group’s instances under the group', () => {
    const [tick] = simulateCrowd(sceneWithGroup({ desired: 4 }), CROWD, timeline([1, 4])).ticks
    expect(tick?.serving).toEqual([{ resourceId: 'asg', instances: 4, capacity: 4 * SMALL }])
    expect(tick?.zonesInService).toBe(2)
  })

  it('a single instance is in one Availability Zone', () => {
    const scene = sceneWithGroup({ min: 1, desired: 1 })
    expect(simulateCrowd(scene, CROWD, timeline([1, 4])).ticks[0]?.zonesInService).toBe(1)
  })
})

describe('timed-out kites', () => {
  const busy = () => simulateCrowd(workingScene(), CROWD, timeline([1, 2 * SMALL + 7]))

  it('records the journey of a kite that timed out: outcome dropped, stopped by capacity at the load balancer', () => {
    const timedOut = busy().ticks[0]?.timedOut
    expect(timedOut?.outcome).toBe('dropped')
    const stop = timedOut ? failingStep(timedOut) : undefined
    expect(stop?.check).toBe('capacity')
    expect(stop?.at).toEqual({ kind: 'resource', id: 'alb' })
    expect(stop?.explanation).toMatch(/504/)
  })

  it('passes the same checks as a served kite on its way to the load balancer', () => {
    const [tick] = busy().ticks
    const served = tick?.served.trace ?? []
    const selection = served.findIndex((step) => step.check === 'target-selection')
    const beforeStop = (tick?.timedOut?.trace ?? []).slice(0, -1)
    expect(beforeStop).toEqual(served.slice(0, selection))
    expect(beforeStop.every((step) => step.result === 'pass')).toBe(true)
  })

  it('records a served kite whose journey ends delivered', () => {
    expect(busy().ticks[0]?.served.outcome).toBe('delivered')
  })

  it('has no timed-out journey when everyone was served', () => {
    const record = simulateCrowd(workingScene(), CROWD, timeline([1, 2 * SMALL]))
    expect(record.ticks[0]?.timedOut).toBeNull()
  })

  it('has no timed-out journey when the crowd is blocked: the served journey shows what stopped it', () => {
    const scene = sceneWith((draft) => (byId(draft.securityGroups, 'sg-alb').inbound = []))
    const [tick] = simulateCrowd(scene, CROWD, timeline([1, 40])).ticks
    expect(tick?.timedOut).toBeNull()
    expect(tick?.served.outcome).toBe('blocked')
    expect(tick && failingStep(tick.served)?.check).toBe('security-group')
  })
})

describe('target tracking scaling', () => {
  const surge = timeline([2, 4], [10, 40], [12, 4])

  it('does nothing without a scaling policy: the group stays at its size', () => {
    const record = simulateCrowd(sceneWithGroup(), CROWD, surge)
    expect(record.peakTargetsInService).toBe(2)
    expect(record.deliveredPercent < 60).toBe(true)
  })

  it('scales out when CPU is above the target, and the new instances serve only after launching', () => {
    const record = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      CROWD,
      surge,
    )
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
      CROWD,
      timeline([1, 6]),
    )
    const steep = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      CROWD,
      timeline([1, 40]),
    )
    expect(gentle.ticks[0]?.launching).toBe(1)
    expect(steep.ticks[0]?.launching).toBeGreaterThan(1)
  })

  it('never exceeds max', () => {
    const record = simulateCrowd(
      sceneWithGroup({ max: 3, scaling: { targetCpuPercent: 50 } }),
      CROWD,
      surge,
    )
    expect(record.peakTargetsInService).toBe(3)
  })

  it('scales in more gradually than out: only after CPU stays low, and by at most half at once', () => {
    const record = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      CROWD,
      timeline([4, 40], [10, 4]),
    )
    const serving = record.ticks.map((tick) => tick.targetsInService)
    // Scaling out reacted on the first busy tick: by tick 4 the fleet had grown to 8.
    expect(serving[4]).toBe(8)
    // The crowd left at tick 4. Nothing is removed until CPU has stayed low for a while…
    for (let tick = 4; tick < 4 + SCALE_IN_TICKS; tick += 1) expect(serving[tick]).toBe(8)
    expect(SCALE_IN_TICKS).toBeGreaterThan(1)
    // …and then the fleet halves, rather than dropping straight to its minimum.
    expect(serving[4 + SCALE_IN_TICKS]).toBe(4)
    for (let tick = 1; tick < serving.length; tick += 1) {
      expect(serving[tick]! >= Math.ceil(serving[tick - 1]! / 2)).toBe(true)
    }
    expect(record.finalTargetsInService).toBe(2)
  })

  it('scales in to the fewest instances that keep CPU at or under the target', () => {
    // Four small instances at 60% (12 kites, room for 20) and an 80% target: three
    // instances would run at 80%, two at 120%. So the group settles at three.
    const record = simulateCrowd(
      sceneWithGroup({ desired: 4, scaling: { targetCpuPercent: 80 } }),
      CROWD,
      timeline([8, 12]),
    )
    expect(record.finalTargetsInService).toBe(3)
    expect(record.ticks.at(-1)?.cpuPercent).toBe(80)
    expect(record.ticks.some((tick) => tick.alarm === 'low-cpu')).toBe(true)
  })

  it('a group that no load balancer sends requests to serves nothing, so it never scales out', () => {
    // The fixed instances are overwhelmed, but the group is not a target: its own CPU is 0%.
    const scene = sceneWith((draft) => {
      draft.resources.push(group({ scaling: { targetCpuPercent: 50 } }))
    })
    const record = simulateCrowd(scene, CROWD, timeline([6, 40]))
    expect(record.ticks.every((tick) => tick.dropped > 0)).toBe(true)
    expect(record.ticks.every((tick) => tick.launching === 0)).toBe(true)
    expect(record.ticks.every((tick) => tick.fleets[0]?.attached === false)).toBe(true)
    expect(record.ticks.every((tick) => tick.fleets[0]?.inService === 2)).toBe(true)
  })

  it('records when a group starts and removes instances', () => {
    const record = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      CROWD,
      timeline([4, 40], [10, 4]),
    )
    const fleet = (tick: number) => record.ticks[tick]?.fleets[0]
    expect(fleet(0)?.started).toBe(2)
    expect(fleet(0)?.attached).toBe(true)
    expect(fleet(1)?.started).toBe(0)
    expect(fleet(3 + SCALE_IN_TICKS)?.stopped).toBe(4)
    const started = record.ticks.reduce((sum, tick) => sum + (tick.fleets[0]?.started ?? 0), 0)
    const stopped = record.ticks.reduce((sum, tick) => sum + (tick.fleets[0]?.stopped ?? 0), 0)
    // Every instance started and every one removed is accounted for: 2 + started − stopped = 2.
    expect(2 + started - stopped).toBe(record.finalTargetsInService)
  })

  it('never goes below min', () => {
    const record = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 50 } }),
      CROWD,
      timeline([20, 0]),
    )
    expect(record.finalTargetsInService).toBe(2)
  })

  it('does not scale in if that would push CPU back over the target', () => {
    // Three instances at 60%: two would run at 90%, well over a 70% target.
    const scene = sceneWithGroup({ desired: 3, scaling: { targetCpuPercent: 70 } })
    const record = simulateCrowd(scene, CROWD, timeline([6, 9]))
    expect(record.finalTargetsInService).toBe(3)
    expect(record.ticks.every((tick) => tick.alarm === 'ok')).toBe(true)
  })

  it('a lower CPU target keeps more headroom, so fewer kites are dropped', () => {
    const at80 = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 80 } }),
      CROWD,
      timeline([2, 4], [2, 12], [2, 24], [10, 40]),
    )
    const at40 = simulateCrowd(
      sceneWithGroup({ scaling: { targetCpuPercent: 40 } }),
      CROWD,
      timeline([2, 4], [2, 12], [2, 24], [10, 40]),
    )
    expect(at40.delivered).toBeGreaterThan(at80.delivered)
  })
})

describe('crowd predicates', () => {
  const surge = timeline([2, 4], [10, 40], [12, 4])

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
    const record = simulateCrowd(scene, CROWD, timeline([1, 2 * SMALL], [1, 4 * SMALL]))
    // 10 of 10, then 10 of 20: 20 of 30 delivered, which is 66%.
    expect(record.deliveredPercent).toBe(66)
    expect(
      evaluatePredicate(scene, [], { kind: 'crowd-delivered-at-least', percent: 66 }, record),
    ).toBe(true)
    expect(
      evaluatePredicate(scene, [], { kind: 'crowd-delivered-at-least', percent: 67 }, record),
    ).toBe(false)
  })

  it('crowd-delivered-at-least can count only the ticks of a surge', () => {
    const scene = workingScene()
    const moments: CrowdMoment[] = [
      { kites: 2 * SMALL, surge: false }, // all 10 delivered
      { kites: 4 * SMALL, surge: true }, // 10 of 20 delivered
    ]
    const record = simulateCrowd(scene, CROWD, moments)
    const duringSurge = (percent: number) =>
      evaluatePredicate(
        scene,
        [],
        { kind: 'crowd-delivered-at-least', percent, during: 'surge' },
        record,
      )
    expect(duringSurge(50)).toBe(true)
    expect(duringSurge(51)).toBe(false)
    // Over the whole run the same record reaches 66%.
    expect(
      evaluatePredicate(scene, [], { kind: 'crowd-delivered-at-least', percent: 66 }, record),
    ).toBe(true)
  })

  it('crowd-delivered-at-least during a surge is false when there was no surge', () => {
    const scene = workingScene()
    const record = simulateCrowd(scene, CROWD, timeline([3, 4]))
    expect(
      evaluatePredicate(
        scene,
        [],
        { kind: 'crowd-delivered-at-least', percent: 0, during: 'surge' },
        record,
      ),
    ).toBe(false)
  })

  it('crowd-quiet-cpu-at-least judges the ticks before the crowd first grows', () => {
    const moments: CrowdMoment[] = [
      { kites: 4, surge: false },
      { kites: 4, surge: false },
      { kites: 40, surge: true },
    ]
    const quiet = (scene: Scene, percent: number) =>
      evaluatePredicate(
        scene,
        [],
        { kind: 'crowd-quiet-cpu-at-least', percent },
        simulateCrowd(scene, CROWD, moments),
      )
    // Two small instances, four kites: 40%.
    expect(quiet(workingScene(), 40)).toBe(true)
    expect(quiet(workingScene(), 41)).toBe(false)
    // Two large instances for the same four kites: 10%, oversized for the usual crowd.
    const large = sceneWithGroup({ size: 'large' })
    expect(quiet(large, 30)).toBe(false)
  })

  it('crowd-quiet-cpu-at-least is false for a crowd that never grows or is busy from the start', () => {
    const scene = workingScene()
    const never = simulateCrowd(scene, CROWD, timeline([3, 4]))
    const busy = simulateCrowd(scene, CROWD, [{ kites: 40, surge: true }])
    const predicate = { kind: 'crowd-quiet-cpu-at-least', percent: 0 } as const
    expect(evaluatePredicate(scene, [], predicate, never)).toBe(false)
    expect(evaluatePredicate(scene, [], predicate, busy)).toBe(false)
  })

  it('crowd-zones-at-least needs targets in that many Availability Zones on every tick', () => {
    const zones = (scene: Scene) =>
      evaluatePredicate(
        scene,
        [],
        { kind: 'crowd-zones-at-least', zones: 2 },
        simulateCrowd(scene, CROWD, timeline([3, 4])),
      )
    expect(zones(workingScene())).toBe(true)
    expect(zones(sceneWithGroup({ min: 1, desired: 1 }))).toBe(false)
  })

  it('crowd-scaled-out-and-back-in needs capacity to have grown and then shrunk', () => {
    const fixed = workingScene()
    expect(
      evaluatePredicate(
        fixed,
        [],
        { kind: 'crowd-scaled-out-and-back-in' },
        simulateCrowd(fixed, CROWD, surge),
      ),
    ).toBe(false)
    const scaled = sceneWithGroup({ scaling: { targetCpuPercent: 50 } })
    expect(
      evaluatePredicate(
        scaled,
        [],
        { kind: 'crowd-scaled-out-and-back-in' },
        simulateCrowd(scaled, CROWD, surge),
      ),
    ).toBe(true)
  })
})

describe('predicates about attaching and scaling a group', () => {
  it('targets-include asks whether the load balancer sends requests to that cloud', () => {
    const attached = sceneWithGroup()
    const detached = sceneWith((draft) => draft.resources.push(group()))
    const asks = { kind: 'targets-include', loadBalancerId: 'alb', targetId: 'asg' } as const
    expect(evaluatePredicate(attached, [], asks)).toBe(true)
    expect(evaluatePredicate(detached, [], asks)).toBe(false)
  })

  it('group-can-scale needs a scaling policy and a maximum above the minimum', () => {
    const can = (overrides: Partial<AutoScalingGroup>) =>
      evaluatePredicate(sceneWithGroup(overrides), [], { kind: 'group-can-scale', groupId: 'asg' })
    expect(can({ scaling: { targetCpuPercent: 50 } })).toBe(true)
    expect(can({ scaling: null })).toBe(false)
    expect(can({ min: 2, max: 2, scaling: { targetCpuPercent: 50 } })).toBe(false)
  })

  it('none-of holds only when none of its predicates do', () => {
    const scene = sceneWithGroup()
    const targets = (targetId: string) =>
      ({ kind: 'targets-include', loadBalancerId: 'alb', targetId }) as const
    expect(
      evaluatePredicate(scene, [], {
        kind: 'none-of',
        predicates: [targets('app-a'), targets('app-b')],
      }),
    ).toBe(true)
    expect(
      evaluatePredicate(scene, [], {
        kind: 'none-of',
        predicates: [targets('app-a'), targets('asg')],
      }),
    ).toBe(false)
  })
})
