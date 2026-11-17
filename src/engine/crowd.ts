// Crowds: many Cloudlings over time, capacity, and Auto Scaling.
//
// A single kite answers "does this request get through?". A crowd adds two
// questions that need time: "is there enough capacity for everyone?" and "does the
// architecture keep up when the crowd grows?". `simulateCrowd` answers both by
// stepping through a timeline of moments (see timeline.ts). It is pure and has no
// randomness: the same scene and timeline always produce the same record.
//
// AWS behaviour modelled:
// - Each instance can serve a fixed number of requests per tick, by size. The load
//   balancer shares requests between healthy targets. A request beyond their total
//   capacity reaches a target that is already busy, gets no answer before the load
//   balancer's idle timeout, and the client receives HTTP 504 (outcome `dropped`).
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
import {
  findResourceOfKind,
  resourcesOfKind,
  type AutoScalingGroup,
  type Ec2Instance,
  type Scene,
} from './model'
import { HTTPS_PORT } from './ports'
import type { Crowd, CrowdMoment } from './timeline'
import type { FlowResult, TraceStep } from './trace'

/** Requests one instance can serve per tick. */
export const REQUESTS_PER_TICK: Record<Ec2Instance['size'], number> = {
  small: 5,
  medium: 10,
  large: 20,
}

/** Ticks between deciding to launch an instance and it serving requests. */
export const LAUNCH_TICKS = 2

/** The state of the scaling policy's CloudWatch alarms during a tick. */
export type AlarmState = 'ok' | 'high-cpu' | 'low-cpu'

export type TickRecord = {
  tick: number
  /** Kites flown this tick. */
  demand: number
  /** True while a crowd surge is under way. */
  surge: boolean
  delivered: number
  /** Timed out: more requests than healthy capacity. */
  dropped: number
  /** Stopped by a control or a missing route: capacity was never the problem. */
  blocked: number
  /** Healthy targets behind the load balancer this tick. */
  targetsInService: number
  /** Instances an Auto Scaling group has started that are not serving yet. */
  launching: number
  cpuPercent: number
  alarm: AlarmState
  /**
   * What happened to a kite that was served this tick, or, when the crowd cannot get
   * through at all, what stopped it. Every kite in the crowd is alike, so one trace
   * speaks for all of them.
   */
  served: FlowResult
  /** What happened to a kite that timed out this tick, if any did. */
  timedOut: FlowResult | null
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

/** Totals for some of a run's ticks, e.g. only those during a surge. */
export function deliveredShare(ticks: TickRecord[]): {
  demand: number
  delivered: number
  percent: number
} {
  const demand = ticks.reduce((sum, record) => sum + record.demand, 0)
  const delivered = ticks.reduce((sum, record) => sum + record.delivered, 0)
  // Rounded down, so "95%" is never claimed for 94.6%.
  return { demand, delivered, percent: demand === 0 ? 100 : Math.floor((delivered / demand) * 100) }
}

/**
 * Steps through `timeline`, one moment per tick. The crowd's size comes from the
 * timeline; from the crowd itself only where it is heading and who it is are needed.
 */
export function simulateCrowd(
  scene: Scene,
  crowd: Pick<Crowd, 'loadBalancerId' | 'ip'>,
  timeline: CrowdMoment[],
): CrowdRecord {
  const groups: GroupState[] = resourcesOfKind(scene, 'auto-scaling-group').map((group) => ({
    group,
    inService: runningCount(group),
    launches: [],
  }))
  const loadBalancer = findResourceOfKind(scene, 'load-balancer', crowd.loadBalancerId)
  const ticks: TickRecord[] = []

  timeline.forEach((moment, tick) => {
    const demand = moment.kites

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
    const served = evaluateFlow(live, {
      id: 'crowd',
      source: { kind: 'internet', ip: crowd.ip },
      destination: { kind: 'resource', id: crowd.loadBalancerId },
      port: HTTPS_PORT,
      payload: 'clean',
      intent: 'legitimate',
      sequence: tick,
    })
    const reachable = served.outcome === 'delivered'

    // 4. Capacity: what the healthy targets can serve this tick.
    const targets = healthyTargets(live, crowd.loadBalancerId)
    const capacity = targets.reduce((sum, target) => sum + REQUESTS_PER_TICK[target.size], 0)
    const delivered = reachable ? Math.min(demand, capacity) : 0
    const dropped = reachable ? demand - delivered : 0
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
      surge: moment.surge,
      delivered,
      dropped,
      blocked: reachable ? 0 : demand,
      targetsInService: targets.length,
      launching: groups.reduce((sum, state) => sum + state.launches.length, 0),
      cpuPercent,
      alarm,
      served,
      timedOut:
        dropped > 0
          ? timedOutResult(
              served,
              crowd.loadBalancerId,
              loadBalancer?.name ?? 'The load balancer',
              {
                demand,
                capacity,
                targets: targets.length,
              },
            )
          : null,
    })
  })

  const whole = deliveredShare(ticks)
  return {
    ticks,
    demand: whole.demand,
    delivered: whole.delivered,
    deliveredPercent: whole.percent,
    peakTargetsInService: Math.max(0, ...ticks.map((record) => record.targetsInService)),
    finalTargetsInService: ticks.at(-1)?.targetsInService ?? 0,
  }
}

/**
 * The journey of a kite that timed out: the same checks as a served kite up to the
 * load balancer, then a capacity step that fails. AWS behaviour modelled: a target
 * that is too busy does not answer before the load balancer's idle timeout, and the
 * client receives HTTP 504 (Gateway Timeout). The fix is more targets.
 */
function timedOutResult(
  served: FlowResult,
  loadBalancerId: string,
  loadBalancerName: string,
  load: { demand: number; capacity: number; targets: number },
): FlowResult {
  const selection = served.trace.findIndex((step) => step.check === 'target-selection')
  const beforeSelection = selection === -1 ? served.trace : served.trace.slice(0, selection)
  const healthy = `${load.targets} healthy target${load.targets === 1 ? '' : 's'}`
  const capacityStep: TraceStep = {
    leg: 'request',
    at: { kind: 'resource', id: loadBalancerId },
    check: 'capacity',
    result: 'fail',
    ruleRef: `${load.demand} kites, room for ${load.capacity} (${healthy})`,
    explanation: `${load.demand} kites arrived this tick, but the ${healthy} of "${loadBalancerName}" can serve only ${load.capacity} between them. This kite went to a target that was already busy. No answer came before the load balancer's idle timeout, so the Cloudling got an error instead (HTTP 504 Gateway Timeout). More targets, or larger ones, would have served it.`,
  }
  return { outcome: 'dropped', trace: [...beforeSelection, capacityStep] }
}
