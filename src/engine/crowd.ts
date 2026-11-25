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
// - Each Cloudling in the crowd keeps one kite up: a steady stream of requests. So
//   the crowd's size is the load, and an instance's capacity is how many kites it
//   has room for at once (ADR 0012).
// - A target tracking scaling policy keeps average CPU near a target. When CPU is
//   above the target the group scales out at once, in proportion to how far above it
//   is. When CPU is below the target it scales in more gradually, because the policy
//   favours availability: only after CPU has stayed low for SCALE_IN_TICKS ticks, and
//   never by more than half the fleet at once, and never so far that CPU would go back
//   over the target. EC2 Auto Scaling creates the CloudWatch alarms for this itself.
// - A group's CPU is its own instances' average. A group that no load balancer sends
//   requests to serves nothing, so its CPU is 0% and it never scales out.
// - A new instance takes time to launch and pass health checks before it serves
//   anything; removing one is immediate.
// - The group never goes below `min` or above `max`.
// - A group spreads its instances evenly across its subnets' Availability Zones: it
//   launches in the zone with the fewest, and scales in from the zone with the most.
//
// When an Availability Zone fails (ADR 0014):
// - Everything in it is unhealthy from that tick on: instances, the load balancer's
//   node there (which leaves DNS, so clients reach the other nodes), a NAT Gateway.
// - The load balancer stops sending requests to targets there at once: they fail
//   their health checks.
// - An Auto Scaling group notices its instances there are unhealthy after
//   HEALTH_CHECK_TICKS, terminates them, and launches replacements in its other
//   zones. A group whose subnets are all in the failed zone has nowhere to launch.
// - A database whose primary is there fails over to its Multi-AZ standby, which takes
//   FAILOVER_TICKS; without a standby it is unavailable for the rest of the run.
//
// Each tick, a kite's journey is evaluated once for each healthy target, and the
// crowd's kites are shared between targets by their room. So when some targets can
// answer and others cannot (one is turned away by the database, say), the record
// says how many of each.

import { groupInstanceId, groupInstances } from './autoScaling'
import { evaluateFlow, healthyTargets } from './flow'
import {
  findResourceOfKind,
  resourcesOfKind,
  type AutoScalingGroup,
  type AvailabilityZone,
  type Ec2Instance,
  type RdsDatabase,
  type Resource,
  type Scene,
} from './model'
import { HTTPS_PORT } from './ports'
import type { Crowd, CrowdMoment } from './timeline'
import type { FlowOutcome, FlowResult, TraceStep } from './trace'

/**
 * Kites one instance has room for at once, by size. Each Cloudling keeps one kite up,
 * so this is also the requests it can serve per tick.
 */
export const REQUESTS_PER_TICK: Record<Ec2Instance['size'], number> = {
  small: 5,
  medium: 10,
  large: 20,
}

/** Ticks between deciding to launch an instance and it serving requests. */
export const LAUNCH_TICKS = 2

/**
 * Ticks in a row that CPU must stay below the target before a group removes
 * instances. Scaling out needs only one: target tracking scales in more gradually.
 */
export const SCALE_IN_TICKS = 2

/**
 * Ticks after an Availability Zone fails before an Auto Scaling group has noticed that
 * its instances there are unhealthy, terminated them and started replacements.
 */
export const HEALTH_CHECK_TICKS = 2

/**
 * Ticks a Multi-AZ database takes to fail over to its standby: AWS says failover
 * typically takes 60–120 seconds, and a tick is one minute.
 */
export const FAILOVER_TICKS = 2

/** The state of the scaling policy's CloudWatch alarms during a tick. */
export type AlarmState = 'ok' | 'high-cpu' | 'low-cpu'

export type TickRecord = {
  tick: number
  /** Kites flown this tick. */
  demand: number
  /** True while a crowd surge is under way. */
  surge: boolean
  delivered: number
  /**
   * Timed out: more requests than healthy capacity, or no healthy target at all, or a
   * database that could not answer.
   */
  dropped: number
  /** Stopped by a control or a missing route: capacity was never the problem. */
  blocked: number
  /** Availability Zones that are down this tick. */
  failedZones: AvailabilityZone[]
  /** Each database's state this tick: answering, failing over, or down. */
  databases: {
    databaseId: string
    status: RdsDatabase['status']
    primaryZone: AvailabilityZone
    standbyZone: AvailabilityZone | null
  }[]
  /** Healthy targets behind the load balancer this tick. */
  targetsInService: number
  /** Kites the healthy targets have room for this tick. */
  capacity: number
  /** Availability Zones with at least one healthy target this tick. */
  zonesInService: number
  /**
   * The healthy targets, by the cloud the player placed: a fixed instance, or an Auto
   * Scaling group with all its serving instances. Shows where the crowd's kites go.
   */
  serving: {
    resourceId: string
    zone: AvailabilityZone
    instances: number
    capacity: number
    /** What happens to a kite sent to these instances. */
    outcome: FlowOutcome
  }[]
  /** Instances an Auto Scaling group has started that are not serving yet. */
  launching: number
  /**
   * Each Auto Scaling group's own instances: serving this tick, still launching at the
   * end of it, and how many it started and removed when it acted at the end of the tick.
   */
  fleets: {
    groupId: string
    inService: number
    launching: number
    started: number
    stopped: number
    /** Whether any load balancer sends requests to this group. */
    attached: boolean
    /** The same by Availability Zone; failed instances are unhealthy, not yet replaced. */
    zones: Record<AvailabilityZone, ZoneCount>
    /** Unhealthy instances the group terminated this tick, to launch replacements. */
    replaced: number
  }[]
  /** How busy the load balancer's targets are: kites ÷ room, capped at 100. */
  cpuPercent: number
  alarm: AlarmState
  /**
   * What happened to a kite that was served this tick, or, when the crowd cannot get
   * through at all, what stopped it. Every kite in the crowd is alike, so one trace
   * speaks for all of them.
   */
  served: FlowResult
  /**
   * What happened to a kite that reached a target but got no answer, or was turned
   * away after it (by the database's security group, say), if any were.
   */
  stopped: FlowResult | null
  /** What happened to a kite that timed out for lack of room this tick, if any did. */
  timedOut: FlowResult | null
}

/**
 * A group's instances in one Availability Zone during a tick: serving and failed at
 * its start; launching at its end; and how many it started and terminated there when
 * it acted at the end of the tick.
 */
export type ZoneCount = {
  serving: number
  launching: number
  failed: number
  started: number
  terminated: number
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

/** One instance of a group, by where it runs. */
type Placed = { subnetId: string; zone: AvailabilityZone }

type GroupState = {
  group: AutoScalingGroup
  /** Instances serving requests (healthy, in a zone that is up). */
  serving: Placed[]
  /** Instances in a failed zone, unhealthy and not yet replaced, with when they failed. */
  failed: (Placed & { since: number })[]
  /** Instances still launching, with ticks left. */
  launches: (Placed & { left: number })[]
  /** Ticks in a row on which CPU has been low enough to remove instances. */
  lowTicks: number
}

type DatabaseState = {
  database: RdsDatabase
  status: RdsDatabase['status']
  primarySubnetId: string
  standbySubnetId: string | null
  /** Ticks left until a failover completes. */
  failoverLeft: number
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

const zoneOf = (scene: Scene, subnetId: string): AvailabilityZone =>
  scene.subnets.find((subnet) => subnet.id === subnetId)?.availabilityZone ?? 'a'

/**
 * Where a group launches its next instance: the subnet, in a zone that is up, holding
 * the fewest of its instances (AWS balances a group across its Availability Zones).
 * Null if every one of its subnets is in a failed zone.
 */
function nextSubnet(scene: Scene, state: GroupState, down: AvailabilityZone[]): Placed | null {
  const count = (subnetId: string) =>
    [...state.serving, ...state.launches].filter((placed) => placed.subnetId === subnetId).length
  const open = state.group.subnetIds.filter((id) => !down.includes(zoneOf(scene, id)))
  if (open.length === 0) return null
  const subnetId = open.reduce((best, id) => (count(id) < count(best) ? id : best))
  return { subnetId, zone: zoneOf(scene, subnetId) }
}

/** The instance to remove when scaling in: one from the zone with the most. Returns its zone. */
function removeOne(state: GroupState): AvailabilityZone | null {
  const perSubnet = (subnetId: string) =>
    state.serving.filter((placed) => placed.subnetId === subnetId).length
  let index = -1
  let most = -1
  state.serving.forEach((placed, position) => {
    const count = perSubnet(placed.subnetId)
    if (count >= most) {
      most = count
      index = position
    }
  })
  if (index < 0) return null
  const [removed] = state.serving.splice(index, 1)
  return removed?.zone ?? null
}

const emptyZones = (): Record<AvailabilityZone, ZoneCount> => ({
  a: { serving: 0, launching: 0, failed: 0, started: 0, terminated: 0 },
  b: { serving: 0, launching: 0, failed: 0, started: 0, terminated: 0 },
})

/**
 * Steps through `timeline`, one moment per tick. The crowd's size and any outage come
 * from the timeline; from the crowd itself only where it is heading, who it is, and
 * the work the application does for each request are needed.
 */
export function simulateCrowd(
  scene: Scene,
  crowd: Pick<Crowd, 'loadBalancerId' | 'ip' | 'backendCall'>,
  timeline: CrowdMoment[],
): CrowdRecord {
  const groups: GroupState[] = resourcesOfKind(scene, 'auto-scaling-group').map((group) => ({
    group,
    serving: groupInstances(group).map((instance) => ({
      subnetId: instance.subnetId,
      zone: zoneOf(scene, instance.subnetId),
    })),
    failed: [],
    launches: [],
    lowTicks: 0,
  }))
  const databases: DatabaseState[] = resourcesOfKind(scene, 'rds-database').map((database) => {
    const primaryZone = zoneOf(scene, database.primarySubnetId)
    const standby = database.multiAz
      ? (database.subnetIds.find((id) => zoneOf(scene, id) !== primaryZone) ?? null)
      : null
    return {
      database,
      status: 'available',
      primarySubnetId: database.primarySubnetId,
      standbySubnetId: standby,
      failoverLeft: 0,
    }
  })
  const attachedIds = new Set(
    resourcesOfKind(scene, 'load-balancer').flatMap((loadBalancer) => loadBalancer.targetIds),
  )
  const loadBalancer = findResourceOfKind(scene, 'load-balancer', crowd.loadBalancerId)
  const ticks: TickRecord[] = []

  timeline.forEach((moment, tick) => {
    const demand = moment.kites
    const down = moment.failedZones ?? []

    // 1. The outage, if any. Instances in a failed zone stop serving at once; launches
    //    there fail. Instances that have finished launching start serving.
    for (const state of groups) {
      for (const placed of state.serving.filter((candidate) => down.includes(candidate.zone)))
        state.failed.push({ ...placed, since: tick })
      state.serving = state.serving.filter((placed) => !down.includes(placed.zone))
      state.launches = state.launches
        .filter((launch) => !down.includes(launch.zone))
        .map((launch) => ({ ...launch, left: launch.left - 1 }))
      state.serving.push(...state.launches.filter((launch) => launch.left <= 0))
      state.launches = state.launches.filter((launch) => launch.left > 0)
    }
    for (const state of databases) {
      if (state.status === 'failing-over') {
        state.failoverLeft -= 1
        if (state.failoverLeft <= 0 && state.standbySubnetId) {
          // The standby is now the primary. Its old zone is down, so there is no new standby.
          state.status = 'available'
          state.primarySubnetId = state.standbySubnetId
          state.standbySubnetId = null
        }
      }
      if (state.standbySubnetId && down.includes(zoneOf(scene, state.standbySubnetId)))
        state.standbySubnetId = null
      if (state.status === 'available' && down.includes(zoneOf(scene, state.primarySubnetId))) {
        if (state.standbySubnetId) {
          state.status = 'failing-over'
          state.failoverLeft = FAILOVER_TICKS
        } else state.status = 'unavailable'
      }
    }

    // 2. The scene as it stands this tick: each group's instances where they are, the
    //    outage, and each database's state.
    const live = liveScene(scene, groups, databases, down)
    const zonesAtStart = groups.map((state) => {
      const zones = emptyZones()
      for (const placed of state.serving) zones[placed.zone].serving += 1
      for (const placed of state.failed) zones[placed.zone].failed += 1
      return zones
    })
    const servingAtStart = groups.map((state) => state.serving.length)

    // 3. A kite's journey through each healthy target. Every kite in the crowd is
    //    alike, so the controls treat all kites sent to one target alike.
    const targets = healthyTargets(live, crowd.loadBalancerId)
    const nodeCount = Math.max(
      1,
      (loadBalancer?.subnetIds ?? []).filter((id) => !down.includes(zoneOf(scene, id))).length,
    )
    const journey = (sequence: number) =>
      evaluateFlow(live, {
        id: 'crowd',
        source: { kind: 'internet', ip: crowd.ip },
        destination: { kind: 'resource', id: crowd.loadBalancerId },
        port: HTTPS_PORT,
        payload: 'clean',
        intent: 'legitimate',
        sequence,
        ...(crowd.backendCall ? { backendCall: crowd.backendCall } : {}),
      })
    // Turn n of the round robin, through the first node, picks the nth healthy target.
    const journeys =
      targets.length > 0
        ? targets.map((target, turn) => ({ target, result: journey(turn * nodeCount) }))
        : [{ target: null, result: journey(tick) }]

    // 4. Capacity: what the healthy targets can serve this tick, shared out by room.
    const roomOf = (target: Ec2Instance | null) => (target ? REQUESTS_PER_TICK[target.size] : 0)
    const capacity = targets.reduce((sum, target) => sum + roomOf(target), 0)
    const reachedTargets = journeys.some((entry) =>
      entry.result.trace.some(
        (step) => step.check === 'target-selection' && step.result === 'pass',
      ),
    )
    let delivered = 0
    let dropped = 0
    let blocked = 0
    if (capacity === 0) {
      // No healthy target: the one journey says whether the kites were stopped on the
      // way in, or reached a load balancer with nothing healthy behind it.
      if (journeys[0]?.result.outcome === 'blocked') blocked = demand
      else dropped = demand
    } else {
      const room = Math.min(demand, capacity)
      const share = (outcome: FlowOutcome) =>
        journeys
          .filter((entry) => entry.result.outcome === outcome)
          .reduce((sum, entry) => sum + roomOf(entry.target), 0)
      delivered = Math.round((room * share('delivered')) / capacity)
      blocked = Math.round((room * share('blocked')) / capacity)
      dropped = demand - delivered - blocked
    }
    const cpuPercent = capacity === 0 ? 0 : Math.min(100, Math.round((demand / capacity) * 100))
    const zonesInService = new Set(targets.map((target) => zoneOf(scene, target.subnetId))).size
    const serving: TickRecord['serving'] = []
    for (const { target, result } of journeys) {
      if (!target) continue
      // A group's instances are "asg#1", "asg#2"…: count them under the group, by zone.
      const resourceId = target.id.split('#')[0] ?? target.id
      const zone = zoneOf(scene, target.subnetId)
      const entry = serving.find(
        (candidate) => candidate.resourceId === resourceId && candidate.zone === zone,
      )
      if (entry) {
        entry.instances += 1
        entry.capacity += roomOf(target)
        if (entry.outcome === 'delivered') entry.outcome = result.outcome
      } else {
        serving.push({
          resourceId,
          zone,
          instances: 1,
          capacity: roomOf(target),
          outcome: result.outcome,
        })
      }
    }

    const started = groups.map(() => 0)
    const stopped = groups.map(() => 0)
    const replaced = groups.map(() => 0)

    // 5. Health checks: unhealthy instances noticed by now are terminated and
    //    replaced in a zone that is up, if the group has one.
    groups.forEach((state, index) => {
      const noticed = state.failed.filter((placed) => tick - placed.since + 1 >= HEALTH_CHECK_TICKS)
      for (const placed of noticed) {
        const where = nextSubnet(scene, state, down)
        if (!where) continue // Nowhere to launch: the group keeps trying.
        state.failed.splice(state.failed.indexOf(placed), 1)
        state.launches.push({ ...where, left: LAUNCH_TICKS })
        replaced[index] = (replaced[index] ?? 0) + 1
        started[index] = (started[index] ?? 0) + 1
        const zones = zonesAtStart[index]
        if (zones) {
          zones[placed.zone].terminated += 1
          zones[where.zone].started += 1
        }
      }
    })

    // 6. Scaling decisions, taken on this tick's CPU, felt on later ticks.
    let alarm: AlarmState = 'ok'
    groups.forEach((state, index) => {
      const policy = state.group.scaling
      if (!policy) return
      // The group's own CPU: busy only if a load balancer sends it requests.
      const groupCpu = attachedIds.has(state.group.id) && reachedTargets ? cpuPercent : 0
      const inService = state.serving.length
      const committed = inService + state.launches.length
      if (groupCpu > policy.targetCpuPercent) {
        state.lowTicks = 0
        alarm = 'high-cpu'
        // Scale out in proportion: enough instances to bring CPU back to the target.
        const wanted = Math.ceil((inService * groupCpu) / policy.targetCpuPercent)
        const toLaunch = Math.min(wanted, state.group.max) - committed
        for (let n = 0; n < toLaunch; n += 1) {
          const where = nextSubnet(scene, state, down)
          if (!where) break
          state.launches.push({ ...where, left: LAUNCH_TICKS })
          started[index] = (started[index] ?? 0) + 1
          const zones = zonesAtStart[index]
          if (zones) zones[where.zone].started += 1
        }
        return
      }
      // Scale in to the fewest instances that keep CPU at or under the target, but
      // never below min and never by more than half the fleet at once.
      const enough = Math.max(
        state.group.min,
        Math.ceil((inService * groupCpu) / policy.targetCpuPercent),
        Math.ceil(inService / 2),
      )
      if (state.launches.length > 0 || enough >= inService) {
        state.lowTicks = 0
        return
      }
      state.lowTicks += 1
      if (state.lowTicks < SCALE_IN_TICKS) return
      if (alarm === 'ok') alarm = 'low-cpu'
      stopped[index] = inService - enough
      for (let n = 0; n < inService - enough; n += 1) {
        const zone = removeOne(state)
        const zones = zonesAtStart[index]
        if (zone && zones) zones[zone].terminated += 1
      }
      state.lowTicks = 0
    })

    const firstDelivered = journeys.find((entry) => entry.result.outcome === 'delivered')
    const firstStopped = journeys.find(
      (entry) => entry.target !== null && entry.result.outcome !== 'delivered',
    )
    const representative = firstDelivered ?? journeys[0]!
    const timedOutForRoom = demand - Math.min(demand, capacity)
    ticks.push({
      tick,
      demand,
      surge: moment.surge,
      delivered,
      dropped,
      blocked,
      failedZones: down,
      databases: databases.map((state) => ({
        databaseId: state.database.id,
        status: state.status,
        primaryZone: zoneOf(scene, state.primarySubnetId),
        standbyZone: state.standbySubnetId ? zoneOf(scene, state.standbySubnetId) : null,
      })),
      targetsInService: targets.length,
      capacity,
      zonesInService,
      serving,
      launching: groups.reduce((sum, state) => sum + state.launches.length, 0),
      fleets: groups.map((state, index) => {
        const zones = zonesAtStart[index] ?? emptyZones()
        for (const launch of state.launches) zones[launch.zone].launching += 1
        return {
          groupId: state.group.id,
          inService: servingAtStart[index] ?? state.serving.length,
          launching: state.launches.length,
          started: started[index] ?? 0,
          stopped: stopped[index] ?? 0,
          attached: attachedIds.has(state.group.id),
          zones,
          replaced: replaced[index] ?? 0,
        }
      }),
      cpuPercent,
      alarm,
      served: representative.result,
      stopped: firstStopped ? firstStopped.result : null,
      timedOut:
        capacity > 0 && timedOutForRoom > 0 && firstDelivered
          ? timedOutResult(
              firstDelivered.result,
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
 * The scene as one tick sees it. Each group is replaced by its instances as they are
 * now (serving, and failed ones still registered but unhealthy), and the load
 * balancer targets those instances. Instances in a failed zone are unhealthy, and
 * each database has its current primary and status. Groups are removed, so nothing
 * downstream expands them again.
 */
function liveScene(
  scene: Scene,
  groups: GroupState[],
  databases: DatabaseState[],
  down: AvailabilityZone[],
): Scene {
  const instancesOf = new Map<string, Ec2Instance[]>()
  for (const state of groups) {
    const placed = [
      ...state.serving.map((where) => ({ ...where, healthy: true })),
      ...state.failed.map((where) => ({ ...where, healthy: false })),
    ]
    instancesOf.set(
      state.group.id,
      placed.map((where, index) => ({
        kind: 'ec2-instance',
        id: groupInstanceId(state.group.id, index + 1),
        name: `${state.group.name} instance ${index + 1}`,
        subnetId: where.subnetId,
        securityGroupIds: state.group.securityGroupIds,
        roleId: state.group.roleId,
        size: state.group.size,
        healthy: where.healthy,
      })),
    )
  }
  const resources: Resource[] = []
  for (const resource of scene.resources) {
    switch (resource.kind) {
      case 'auto-scaling-group':
        resources.push(...(instancesOf.get(resource.id) ?? []))
        break
      case 'load-balancer':
        resources.push({
          ...resource,
          targetIds: resource.targetIds.flatMap(
            (id) => instancesOf.get(id)?.map((instance) => instance.id) ?? [id],
          ),
        })
        break
      case 'ec2-instance':
        resources.push(
          down.includes(zoneOf(scene, resource.subnetId))
            ? { ...resource, healthy: false }
            : resource,
        )
        break
      case 'rds-database': {
        const state = databases.find((candidate) => candidate.database.id === resource.id)
        resources.push(
          state
            ? { ...resource, status: state.status, primarySubnetId: state.primarySubnetId }
            : resource,
        )
        break
      }
      default:
        resources.push(resource)
    }
  }
  return { ...scene, resources, ...(down.length > 0 ? { failedZones: down } : {}) }
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
