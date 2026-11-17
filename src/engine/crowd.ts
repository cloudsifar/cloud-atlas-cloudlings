// Crowds: many Cloudlings over time, capacity, and Auto Scaling.
//
// A single kite answers "does this request get through?". A crowd adds two
// questions that need time: "is there enough capacity for everyone?" and "does the
// architecture keep up when the crowd grows?". `simulateCrowd` answers both by
// stepping through ticks. It is pure and has no randomness: the same scene and
// crowd always produce the same record.
//
// AWS behaviour modelled:
// - Each instance can serve a fixed number of requests per tick, by size. The load
//   balancer shares requests between healthy targets; requests beyond their total
//   capacity are not served in time (outcome `dropped`).
// - CPU utilisation is how much of that capacity is in use, capped at 100%.
// - A target tracking scaling policy keeps average CPU near a target. When CPU is
//   above the target the group scales out in proportion to how far above it is;
//   when CPU is below the target it scales in gradually, one instance at a time,
//   because the policy favours availability. EC2 Auto Scaling creates the
//   CloudWatch alarms for this itself.
// - A new instance takes time to launch and pass health checks before it serves
//   anything; removing one is immediate.
// - The group never goes below `min` or above `max`.

import { runningCount } from './autoScaling'
import { evaluateFlow, healthyTargets } from './flow'
import { resourcesOfKind, type AutoScalingGroup, type Ec2Instance, type Scene } from './model'
import { HTTPS_PORT } from './ports'

/** Requests one instance can serve per tick. */
export const REQUESTS_PER_TICK: Record<Ec2Instance['size'], number> = {
  small: 5,
  medium: 10,
  large: 20,
}

/** Ticks between deciding to launch an instance and it serving requests. */
export const LAUNCH_TICKS = 2

/** A stretch of time with a steady number of Cloudlings flying kites each tick. */
export type CrowdPhase = { ticks: number; kitesPerTick: number }

/** A crowd of friendly visitors sending HTTPS requests to one load balancer. */
export type Crowd = { loadBalancerId: string; ip: string; phases: CrowdPhase[] }

/** The state of the scaling policy's CloudWatch alarms during a tick. */
export type AlarmState = 'ok' | 'high-cpu' | 'low-cpu'

export type TickRecord = {
  tick: number
  /** Kites flown this tick. */
  demand: number
  delivered: number
  /** Not served in time: more requests than healthy capacity. */
  dropped: number
  /** Stopped by a control or a missing route: capacity was never the problem. */
  blocked: number
  /** Healthy targets behind the load balancer this tick. */
  targetsInService: number
  /** Instances an Auto Scaling group has started that are not serving yet. */
  launching: number
  cpuPercent: number
  alarm: AlarmState
}

export type CrowdRecord = {
  ticks: TickRecord[]
  demand: number
  delivered: number
  /** Whole-number percentage of all kites delivered; 100 when there were none. */
  deliveredPercent: number
  /** The most targets in service at once, and how many were left at the end. */
  peakTargetsInService: number
  finalTargetsInService: number
}

type GroupState = {
  group: AutoScalingGroup
  /** Instances serving requests. */
  inService: number
  /** Ticks left for each instance still launching. */
  launches: number[]
}

export function simulateCrowd(scene: Scene, crowd: Crowd): CrowdRecord {
  const groups: GroupState[] = resourcesOfKind(scene, 'auto-scaling-group').map((group) => ({
    group,
    inService: runningCount(group),
    launches: [],
  }))
  const demands = crowd.phases.flatMap((phase) =>
    Array.from({ length: phase.ticks }, () => phase.kitesPerTick),
  )
  const ticks: TickRecord[] = []

  demands.forEach((demand, tick) => {
    // 1. Instances that have finished launching start serving.
    for (const state of groups) {
      state.launches = state.launches.map((left) => left - 1)
      state.inService += state.launches.filter((left) => left <= 0).length
      state.launches = state.launches.filter((left) => left > 0)
    }

    // 2. The scene as it stands this tick: each group at its current size.
    const live: Scene = {
      ...scene,
      resources: scene.resources.map((resource) => {
        const state = groups.find((candidate) => candidate.group.id === resource.id)
        return state ? { ...state.group, desired: state.inService } : resource
      }),
    }

    // 3. Can a request get through at all? One representative kite decides: every
    //    kite in the crowd is alike, so the controls treat them alike.
    const probe = evaluateFlow(live, {
      id: 'crowd',
      source: { kind: 'internet', ip: crowd.ip },
      destination: { kind: 'resource', id: crowd.loadBalancerId },
      port: HTTPS_PORT,
      payload: 'clean',
      intent: 'legitimate',
      sequence: tick,
    })
    const reachable = probe.outcome === 'delivered'

    // 4. Capacity: what the healthy targets can serve this tick.
    const targets = healthyTargets(live, crowd.loadBalancerId)
    const capacity = targets.reduce((sum, target) => sum + REQUESTS_PER_TICK[target.size], 0)
    const delivered = reachable ? Math.min(demand, capacity) : 0
    const cpuPercent = capacity === 0 ? 0 : Math.min(100, Math.round((demand / capacity) * 100))

    // 5. Scaling decisions, taken on this tick's CPU, felt on later ticks.
    let alarm: AlarmState = 'ok'
    for (const state of groups) {
      const policy = state.group.scaling
      if (!policy) continue
      const committed = state.inService + state.launches.length
      if (cpuPercent > policy.targetCpuPercent) {
        alarm = 'high-cpu'
        // Scale out in proportion: enough instances to bring CPU back to the target.
        const wanted = Math.ceil((state.inService * cpuPercent) / policy.targetCpuPercent)
        const toLaunch = Math.min(wanted, state.group.max) - committed
        for (let n = 0; n < toLaunch; n += 1) state.launches.push(LAUNCH_TICKS)
      } else if (
        state.launches.length === 0 &&
        state.inService > state.group.min &&
        // Only scale in if the remaining instances would still be at or under the target.
        (state.inService * cpuPercent) / (state.inService - 1) <= policy.targetCpuPercent
      ) {
        if (alarm === 'ok') alarm = 'low-cpu'
        state.inService -= 1
      }
    }

    ticks.push({
      tick,
      demand,
      delivered,
      dropped: reachable ? demand - delivered : 0,
      blocked: reachable ? 0 : demand,
      targetsInService: targets.length,
      launching: groups.reduce((sum, state) => sum + state.launches.length, 0),
      cpuPercent,
      alarm,
    })
  })

  const demand = ticks.reduce((sum, record) => sum + record.demand, 0)
  const delivered = ticks.reduce((sum, record) => sum + record.delivered, 0)
  return {
    ticks,
    demand,
    delivered,
    deliveredPercent: demand === 0 ? 100 : Math.floor((delivered / demand) * 100),
    peakTargetsInService: Math.max(0, ...ticks.map((record) => record.targetsInService)),
    finalTargetsInService: ticks.at(-1)?.targetsInService ?? 0,
  }
}
