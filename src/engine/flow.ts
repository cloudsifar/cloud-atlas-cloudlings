// evaluateFlow: what happens to this flow in this scene?
//
// This file is the engine's front door. It decides which journey a flow takes,
// then walks that journey as an ordered list of checks. Each check is a small
// function returning one TraceStep; the walk stops at the first failure.
// The rules themselves live in the rule modules (routing, securityGroups,
// networkAcls, iam, s3); this file only puts them in the order AWS applies them.

import { expandAutoScalingGroups } from './autoScaling'
import { addressInSubnet, S3_ENDPOINT_ADDRESS, SSM_ENDPOINT_ADDRESS } from './address'
import {
  findResource,
  findResourceOfKind,
  resourcesOfKind,
  requireNetworkAcl,
  requireSubnet,
  subnetIsDown,
  webAclFor,
  type Ec2Instance,
  type LoadBalancer,
  type IamRole,
  type RdsDatabase,
  type S3Bucket,
  type Scene,
  type SessionManager,
  type ServiceAction,
  type Subnet,
} from './model'
import { evaluateNetworkAcl } from './networkAcls'
import { evaluateWebAcl, ORDINARY_RATE } from './waf'
import {
  describePort,
  HTTP_PORT,
  HTTPS_PORT,
  MYSQL_PORT,
  POSTGRESQL_PORT,
  REPRESENTATIVE_EPHEMERAL_PORT,
  SSH_PORT,
} from './ports'
import { isPublicSubnet, resolveRoute } from './routing'
import { evaluateIdentityPolicy } from './iam'
import { evaluateKeyUse, needsKeyCheck } from './kms'
import { evaluateBucketAccess, type Caller } from './s3'
import { evaluateSecurityGroups, type ConnectionPeer } from './securityGroups'
import type {
  CheckKind,
  CheckOutcome,
  Flow,
  FlowResult,
  Leg,
  ResourceRef,
  TraceStep,
} from './trace'

/** Targets always listen on HTTP 80; the load balancer terminates HTTPS (docs/SIMPLIFICATIONS.md). */
const TARGET_PORT = HTTP_PORT

type PendingCheck = () => TraceStep

/** Runs checks in order, recording each, and stops at the first failure. Returns true if all passed. */
function runChecks(trace: TraceStep[], checks: PendingCheck[]): boolean {
  for (const check of checks) {
    const step = check()
    trace.push(step)
    if (step.result === 'fail') return false
  }
  return true
}

function makeStep(leg: Leg, at: ResourceRef, check: CheckKind, outcome: CheckOutcome): TraceStep {
  return { leg, at, check, ...outcome }
}

const atResource = (id: string): ResourceRef => ({ kind: 'resource', id })
const atSubnet = (subnet: Subnet): ResourceRef => ({ kind: 'subnet', id: subnet.id })

function naclStep(
  scene: Scene,
  subnet: Subnet,
  direction: 'inbound' | 'outbound',
  peerIp: string,
  port: number,
  leg: Leg,
): TraceStep {
  const acl = requireNetworkAcl(scene, subnet.networkAclId)
  return makeStep(leg, atSubnet(subnet), 'nacl', evaluateNetworkAcl(acl, direction, peerIp, port))
}

// ---------------------------------------------------------------------------
// The front door
// ---------------------------------------------------------------------------

/**
 * Pure and deterministic: the same scene and flow always give the same result.
 * Throws only for source/destination pairings the game does not model, which
 * the level validator rules out before a level can ship.
 */
export function evaluateFlow(authoredScene: Scene, flow: Flow): FlowResult {
  // Auto Scaling groups become ordinary instances first (see autoScaling.ts).
  const scene = expandAutoScalingGroups(authoredScene)
  const destination = findResource(scene, flow.destination.id)
  if (!destination) {
    return {
      outcome: 'blocked',
      trace: [
        makeStep('request', { kind: 'ground' }, 'route', {
          result: 'fail',
          explanation: 'The place this kite is heading for has not been built yet.',
        }),
      ],
    }
  }

  if (flow.source.kind === 'internet') {
    switch (destination.kind) {
      case 'load-balancer':
        return evaluateInternetToLoadBalancer(scene, flow, flow.source.ip, destination)
      case 's3-bucket':
        return evaluateInternetToBucket(flow, destination)
      case 'ec2-instance':
        if (flow.shell) return evaluateShell(scene, flow, flow.source.ip, destination)
        if (destination.publicAddress)
          return evaluateInternetToPublicInstance(scene, flow, flow.source.ip, destination)
        return evaluateInternetToPrivateResource(destination.name)
      default:
        return evaluateInternetToPrivateResource(destination.name)
    }
  }

  const source = findResource(scene, flow.source.id)
  if (source?.kind === 'ec2-instance' && destination.kind === 's3-bucket') {
    return evaluateInstanceToBucketFlow(scene, flow, source, destination)
  }
  throw new Error(
    `evaluateFlow does not model a flow from "${flow.source.id}" to "${flow.destination.id}"`,
  )
}

// ---------------------------------------------------------------------------
// Journey 1: a kite from the ground to the load balancer, and on to a target
// ---------------------------------------------------------------------------

function evaluateInternetToLoadBalancer(
  scene: Scene,
  flow: Flow,
  clientIp: string,
  loadBalancer: LoadBalancer,
): FlowResult {
  const trace: TraceStep[] = []
  const sequence = flow.sequence ?? 0
  // A load balancer has one node per subnet. DNS spreads clients across the nodes;
  // we rotate through them by sequence so the choice is repeatable. A node whose
  // Availability Zone is down is taken out of DNS, so clients reach the others
  // (docs/ENGINE.md, "Availability Zone failure").
  const nodes = loadBalancer.subnetIds.filter((id) => {
    const subnet = scene.subnets.find((candidate) => candidate.id === id)
    return subnet !== undefined && !subnetIsDown(scene, subnet)
  })
  const nodeCount = Math.max(nodes.length, 1)
  const nodeSubnetId = nodes[sequence % nodeCount]
  if (nodeSubnetId === undefined) {
    trace.push(
      makeStep('request', { kind: 'vpc' }, 'route', {
        result: 'fail',
        explanation: `"${loadBalancer.name}" has not been placed in any subnet, so there is nothing to reach.`,
      }),
    )
    return { outcome: 'blocked', trace }
  }
  const nodeSubnet = requireSubnet(scene, nodeSubnetId)
  const client: ConnectionPeer = {
    ip: clientIp,
    securityGroupIds: [],
    description: `the Cloudling at ${clientIp}`,
  }

  // Request path, in AWS order: route in via the Internet Gateway -> NACL of the
  // load balancer's subnet -> the load balancer's security group -> its listener ->
  // the web ACL associated with it, if any, which reads the accepted request (waf.ts).
  const webAcl = webAclFor(scene, loadBalancer.id)
  const reachedLoadBalancer = runChecks(trace, [
    () => internetRouteStep(scene, loadBalancer, nodeSubnet),
    () => naclStep(scene, nodeSubnet, 'inbound', clientIp, flow.port, 'request'),
    () =>
      makeStep(
        'request',
        atResource(loadBalancer.id),
        'security-group',
        evaluateSecurityGroups(scene, loadBalancer.securityGroupIds, 'inbound', client, flow.port),
      ),
    () => listenerStep(loadBalancer, flow.port),
    ...(webAcl
      ? [
          () =>
            makeStep(
              'request',
              atResource(webAcl.id),
              'waf',
              evaluateWebAcl(webAcl, flow, clientIp),
            ),
        ]
      : []),
  ])
  if (!reachedLoadBalancer) return { outcome: 'blocked', trace }

  // Healthy target selection.
  const selection = selectTarget(scene, loadBalancer, nodeSubnet, Math.floor(sequence / nodeCount))
  trace.push(selection.step)
  if (!selection.target) return { outcome: 'dropped', trace }
  const target = selection.target

  // Load balancer -> target: NACLs on both subnet boundaries, then the target's security group.
  const reachedTarget = runChecks(
    trace,
    loadBalancerToTargetChecks(scene, loadBalancer, nodeSubnet, target),
  )
  if (!reachedTarget) return { outcome: 'blocked', trace }

  if (!target.healthy) {
    const targetSubnet = scene.subnets.find((subnet) => subnet.id === target.subnetId)
    const zoneDown = targetSubnet !== undefined && subnetIsDown(scene, targetSubnet)
    trace.push(
      makeStep('request', atResource(target.id), 'delivery', {
        result: 'fail',
        explanation: zoneDown
          ? `"${target.name}" is in Availability Zone ${targetSubnet.availabilityZone}, which is down, so nothing answers and the request times out.`
          : `"${target.name}" is not running, so nothing answers and the request times out.`,
      }),
    )
    return { outcome: 'dropped', trace }
  }
  // A hostile kite that reaches the application has done what it came for: a breach.
  const breached = flow.intent === 'hostile'
  const rate = flow.rate ?? ORDINARY_RATE
  trace.push(
    makeStep('request', atResource(target.id), 'delivery', {
      result: 'pass',
      explanation: !breached
        ? `The request reaches "${target.name}" on ${describePort(TARGET_PORT)}.`
        : flow.payload === 'malicious'
          ? `A malicious request reached "${target.name}". Nothing on the way inspected what the kite was carrying.`
          : rate > ORDINARY_RATE * 10
            ? `A flood of ${rate.toLocaleString('en-GB')} requests in five minutes from one address reached "${target.name}". Nothing on the way counted them.`
            : `A hostile request reached "${target.name}". Its address and port look like anyone's, and nothing on the way turned it away.`,
    }),
  )
  if (breached) return { outcome: 'breach', trace }

  // Any work the application does before it can answer (e.g. storing an upload).
  const database = flow.backendCall
    ? findResourceOfKind(scene, 'rds-database', flow.backendCall.destinationId)
    : undefined
  if (database) {
    // A query to the database: network checks there and back, then the database itself.
    const call = instanceToDatabaseChecks(scene, target, database)
    if (!runChecks(trace, call.request)) return { outcome: 'blocked', trace }
    if (!runChecks(trace, [call.answer])) return { outcome: 'dropped', trace }
    if (!runChecks(trace, call.response)) return { outcome: 'blocked', trace }
  } else if (flow.backendCall) {
    const bucket = findResourceOfKind(scene, 's3-bucket', flow.backendCall.destinationId)
    if (!bucket) {
      trace.push(
        makeStep('backend-request', atResource(target.id), 'route', {
          result: 'fail',
          explanation: `"${target.name}" has nowhere to send this: the bucket has not been built yet.`,
        }),
      )
      return { outcome: 'blocked', trace }
    }
    const call = instanceToBucketChecks(
      scene,
      target,
      bucket,
      flow.backendCall.action ?? 's3:Read',
      {
        request: 'backend-request',
        response: 'backend-response',
      },
    )
    if (!runChecks(trace, [...call.request, ...call.response])) return { outcome: 'blocked', trace }
  }

  // The response retraces the path. Security groups are stateful, so they are not
  // consulted again; NACLs are stateless, so every boundary is judged afresh.
  const responseTrace: TraceStep[] = []
  const responded = runChecks(responseTrace, [
    ...targetToLoadBalancerResponseChecks(scene, loadBalancer, nodeSubnet, target),
    () =>
      naclStep(scene, nodeSubnet, 'outbound', clientIp, REPRESENTATIVE_EPHEMERAL_PORT, 'response'),
    () =>
      makeStep('response', { kind: 'ground' }, 'delivery', {
        result: 'pass',
        explanation: 'The response leaves through the Internet Gateway and reaches the Cloudling.',
      }),
  ])
  return { outcome: responded ? 'delivered' : 'blocked', trace, responseTrace }
}

/**
 * AWS behaviour modelled: traffic from the internet can enter the VPC only
 * through an Internet Gateway, and only to something with a public address in a
 * public subnet. In the game that is an internet-facing load balancer.
 */
function internetRouteStep(
  scene: Scene,
  loadBalancer: LoadBalancer,
  nodeSubnet: Subnet,
): TraceStep {
  if (loadBalancer.scheme === 'internal') {
    return makeStep('request', { kind: 'vpc' }, 'route', {
      result: 'fail',
      explanation: `"${loadBalancer.name}" is an internal load balancer: it has only private addresses, so nothing on the internet can route to it.`,
    })
  }
  if (!isPublicSubnet(scene, nodeSubnet)) {
    return makeStep('request', { kind: 'vpc' }, 'route', {
      result: 'fail',
      explanation: `Subnet "${nodeSubnet.name}" has no route sending 0.0.0.0/0 to an attached Internet Gateway, so it is not a public subnet. The kite finds no gate into the VPC.`,
    })
  }
  return makeStep('request', { kind: 'vpc' }, 'route', {
    result: 'pass',
    ruleRef: '0.0.0.0/0 → Internet Gateway',
    explanation: `The Internet Gateway lets the kite into the VPC, and subnet "${nodeSubnet.name}" is public: its route table sends 0.0.0.0/0 to the Internet Gateway.`,
  })
}

function listenerStep(loadBalancer: LoadBalancer, port: number): TraceStep {
  const listenerPort = loadBalancer.listener === 'https' ? HTTPS_PORT : HTTP_PORT
  const listening = port === listenerPort
  return makeStep('request', atResource(loadBalancer.id), 'listener', {
    result: listening ? 'pass' : 'fail',
    ruleRef: `listener: ${describePort(listenerPort)}`,
    explanation: listening
      ? `"${loadBalancer.name}" has a listener on ${describePort(listenerPort)} and accepts the request.`
      : `"${loadBalancer.name}" listens on ${describePort(listenerPort)} only; nothing is listening on ${describePort(port)}.`,
  })
}

function loadBalancerPeer(loadBalancer: LoadBalancer, nodeSubnet: Subnet): ConnectionPeer {
  return {
    ip: addressInSubnet(nodeSubnet),
    securityGroupIds: loadBalancer.securityGroupIds,
    description: `the load balancer "${loadBalancer.name}"`,
  }
}

function instancePeer(scene: Scene, instance: Ec2Instance): ConnectionPeer {
  return {
    ip: addressInSubnet(requireSubnet(scene, instance.subnetId)),
    securityGroupIds: instance.securityGroupIds,
    description: `"${instance.name}"`,
  }
}

/** The checks between a load balancer node and one target, in order. */
function loadBalancerToTargetChecks(
  scene: Scene,
  loadBalancer: LoadBalancer,
  nodeSubnet: Subnet,
  target: Ec2Instance,
): PendingCheck[] {
  const targetSubnet = requireSubnet(scene, target.subnetId)
  const nodeIp = addressInSubnet(nodeSubnet)
  const targetIp = addressInSubnet(targetSubnet)
  // NACLs guard subnet boundaries; traffic that stays inside one subnet never meets one.
  const crossesBoundary = nodeSubnet.id !== targetSubnet.id
  return [
    () =>
      makeStep(
        'request',
        atResource(loadBalancer.id),
        'security-group',
        evaluateSecurityGroups(
          scene,
          loadBalancer.securityGroupIds,
          'outbound',
          instancePeer(scene, target),
          TARGET_PORT,
        ),
      ),
    ...(crossesBoundary
      ? [
          () => naclStep(scene, nodeSubnet, 'outbound', targetIp, TARGET_PORT, 'request'),
          () => naclStep(scene, targetSubnet, 'inbound', nodeIp, TARGET_PORT, 'request'),
        ]
      : []),
    () =>
      makeStep(
        'request',
        atResource(target.id),
        'security-group',
        evaluateSecurityGroups(
          scene,
          target.securityGroupIds,
          'inbound',
          loadBalancerPeer(loadBalancer, nodeSubnet),
          TARGET_PORT,
        ),
      ),
  ]
}

/** The target's reply to the load balancer node. */
function targetToLoadBalancerResponseChecks(
  scene: Scene,
  loadBalancer: LoadBalancer,
  nodeSubnet: Subnet,
  target: Ec2Instance,
): PendingCheck[] {
  const targetSubnet = requireSubnet(scene, target.subnetId)
  const crossesBoundary = nodeSubnet.id !== targetSubnet.id
  return [
    () =>
      makeStep('response', atResource(target.id), 'security-group', {
        result: 'pass',
        ruleRef: 'stateful: return traffic',
        explanation: `Security groups are stateful: the reply to an allowed request is always allowed, whatever the outbound rules of "${target.name}" or the inbound rules of "${loadBalancer.name}" say.`,
      }),
    ...(crossesBoundary
      ? [
          () =>
            naclStep(
              scene,
              targetSubnet,
              'outbound',
              addressInSubnet(nodeSubnet),
              REPRESENTATIVE_EPHEMERAL_PORT,
              'response',
            ),
          () =>
            naclStep(
              scene,
              nodeSubnet,
              'inbound',
              addressInSubnet(targetSubnet),
              REPRESENTATIVE_EPHEMERAL_PORT,
              'response',
            ),
        ]
      : []),
  ]
}

/**
 * AWS behaviour modelled: the load balancer health-checks each registered
 * target over the network, on the port the target receives traffic on. A target
 * the load balancer cannot reach (failed instance, security group or NACL in
 * the way) is unhealthy.
 */
function targetPassesHealthCheck(
  scene: Scene,
  loadBalancer: LoadBalancer,
  nodeSubnet: Subnet,
  target: Ec2Instance,
): boolean {
  if (!target.healthy) return false
  const scratch: TraceStep[] = []
  return runChecks(scratch, [
    ...loadBalancerToTargetChecks(scene, loadBalancer, nodeSubnet, target),
    ...targetToLoadBalancerResponseChecks(scene, loadBalancer, nodeSubnet, target),
  ])
}

/**
 * The load balancer's registered targets that are passing health checks right now:
 * the instances requests are shared between. Used by the crowd simulation to work
 * out how much capacity is behind the load balancer.
 */
export function healthyTargets(authoredScene: Scene, loadBalancerId: string): Ec2Instance[] {
  const scene = expandAutoScalingGroups(authoredScene)
  const loadBalancer = findResourceOfKind(scene, 'load-balancer', loadBalancerId)
  const firstSubnetId = loadBalancer?.subnetIds[0]
  if (!loadBalancer || firstSubnetId === undefined) return []
  const nodeSubnet = requireSubnet(scene, firstSubnetId)
  return loadBalancer.targetIds
    .map((id) => findResourceOfKind(scene, 'ec2-instance', id))
    .filter((instance): instance is Ec2Instance => instance !== undefined)
    .filter((target) => targetPassesHealthCheck(scene, loadBalancer, nodeSubnet, target))
}

/**
 * AWS behaviour modelled: requests go only to healthy targets, in round-robin
 * order, across all enabled Availability Zones (cross-zone load balancing is on).
 * If every registered target is unhealthy the load balancer "fails open" and
 * routes to all of them anyway. With no registered targets it answers 503 itself.
 */
function selectTarget(
  scene: Scene,
  loadBalancer: LoadBalancer,
  nodeSubnet: Subnet,
  turn: number,
): { step: TraceStep; target?: Ec2Instance } {
  const registered = loadBalancer.targetIds
    .map((id) => findResourceOfKind(scene, 'ec2-instance', id))
    .filter((instance): instance is Ec2Instance => instance !== undefined)
  const at = atResource(loadBalancer.id)

  if (registered.length === 0) {
    return {
      step: makeStep('request', at, 'target-selection', {
        result: 'fail',
        explanation: `"${loadBalancer.name}" has no registered targets, so it has nowhere to send the request and answers with an error (503).`,
      }),
    }
  }

  const healthy = registered.filter((target) =>
    targetPassesHealthCheck(scene, loadBalancer, nodeSubnet, target),
  )
  const failOpen = healthy.length === 0
  const pool = failOpen ? registered : healthy
  const target = pool[turn % pool.length]
  if (!target) throw new Error('unreachable: the target pool is never empty here')

  return {
    target,
    step: makeStep('request', at, 'target-selection', {
      result: 'pass',
      ruleRef: failOpen ? 'fail open: no healthy targets' : `${healthy.length} healthy target(s)`,
      explanation: failOpen
        ? `None of the targets of "${loadBalancer.name}" passes its health check, so the load balancer fails open and tries "${target.name}" anyway.`
        : `"${loadBalancer.name}" picks "${target.name}" from its ${healthy.length} healthy target(s), taking turns (round robin).`,
    }),
  }
}

// ---------------------------------------------------------------------------
// An application instance querying its RDS database
// ---------------------------------------------------------------------------

/** The port each database engine listens on. */
export const ENGINE_PORT: Record<RdsDatabase['engine'], number> = {
  mysql: MYSQL_PORT,
  postgresql: POSTGRESQL_PORT,
}

/**
 * The checks for an instance querying an RDS database in the same VPC.
 *
 * AWS behaviour modelled:
 * - The VPC's local route carries the traffic; it can never be removed.
 * - NACLs judge it where it crosses a subnet boundary, both ways (stateless).
 * - The database's security group must allow the engine port from the caller: by
 *   naming the caller's security group, or an address range the caller is in.
 *   Security groups are stateful, so the reply needs no rule.
 * - The database's endpoint always points at the current primary, so after a
 *   Multi-AZ failover the same query reaches the new primary in the other AZ.
 * - While a failover is under way, or when the primary's AZ is down and there is
 *   no standby, nothing answers: the query fails and so does the request.
 */
function instanceToDatabaseChecks(
  scene: Scene,
  instance: Ec2Instance,
  database: RdsDatabase,
): { request: PendingCheck[]; answer: PendingCheck; response: PendingCheck[] } {
  const instanceSubnet = requireSubnet(scene, instance.subnetId)
  const databaseSubnet = requireSubnet(scene, database.primarySubnetId)
  const instanceIp = addressInSubnet(instanceSubnet)
  const databaseIp = addressInSubnet(databaseSubnet)
  const port = ENGINE_PORT[database.engine]
  const crossesBoundary = instanceSubnet.id !== databaseSubnet.id
  const leg = 'backend-request'
  const back = 'backend-response'
  const databasePeer: ConnectionPeer = {
    ip: databaseIp,
    securityGroupIds: database.securityGroupIds,
    description: `the database "${database.name}"`,
  }
  return {
    request: [
      () =>
        makeStep(leg, atResource(instance.id), 'security-group', {
          ...evaluateSecurityGroups(
            scene,
            instance.securityGroupIds,
            'outbound',
            databasePeer,
            port,
          ),
        }),
      () =>
        makeStep(leg, atSubnet(instanceSubnet), 'route', {
          result: 'pass',
          ruleRef: 'local route (VPC)',
          explanation: `The database is inside the VPC, so the local route of "${instanceSubnet.name}" carries the query. Every route table has it, and it cannot be removed.`,
        }),
      ...(crossesBoundary
        ? [
            () => naclStep(scene, instanceSubnet, 'outbound', databaseIp, port, leg),
            () => naclStep(scene, databaseSubnet, 'inbound', instanceIp, port, leg),
          ]
        : []),
      () =>
        makeStep(
          leg,
          atResource(database.id),
          'security-group',
          evaluateSecurityGroups(
            scene,
            database.securityGroupIds,
            'inbound',
            instancePeer(scene, instance),
            port,
          ),
        ),
    ],
    answer: () => {
      const zone = databaseSubnet.availabilityZone
      switch (database.status) {
        case 'available':
          return makeStep(leg, atResource(database.id), 'delivery', {
            result: 'pass',
            explanation: `"${database.name}" answers the query from its primary in AZ ${zone}.${atRestNote(scene, database)}`,
          })
        case 'failing-over':
          return makeStep(leg, atResource(database.id), 'delivery', {
            result: 'fail',
            explanation: `"${database.name}" is failing over: its primary's Availability Zone is down, and RDS is promoting the standby in the other AZ. That takes a minute or two, and no query is answered until it is done, so this request fails.`,
          })
        case 'unavailable':
          return makeStep(leg, atResource(database.id), 'delivery', {
            result: 'fail',
            explanation: `"${database.name}" is down: it ran only in AZ ${zone}, which has failed, and it has no standby to take over. With Multi-AZ, RDS would have failed over to a standby in the other AZ.`,
          })
      }
    },
    response: crossesBoundary
      ? [
          () =>
            naclStep(
              scene,
              databaseSubnet,
              'outbound',
              instanceIp,
              REPRESENTATIVE_EPHEMERAL_PORT,
              back,
            ),
          () =>
            naclStep(
              scene,
              instanceSubnet,
              'inbound',
              databaseIp,
              REPRESENTATIVE_EPHEMERAL_PORT,
              back,
            ),
        ]
      : [],
  }
}

// ---------------------------------------------------------------------------
// Journey 2: an instance calling S3 (as a backend call, or as a flow of its own)
// ---------------------------------------------------------------------------

function evaluateInstanceToBucketFlow(
  scene: Scene,
  flow: Flow,
  instance: Ec2Instance,
  bucket: S3Bucket,
): FlowResult {
  const call = instanceToBucketChecks(scene, instance, bucket, flow.action ?? 's3:Read', {
    request: 'request',
    response: 'response',
  })
  const trace: TraceStep[] = []
  if (!runChecks(trace, call.request)) return { outcome: 'blocked', trace }
  const responseTrace: TraceStep[] = []
  const responded = runChecks(responseTrace, call.response)
  return { outcome: responded ? 'delivered' : 'blocked', trace, responseTrace }
}

/**
 * The checks for an instance in a private subnet calling Amazon S3.
 *
 * AWS behaviour modelled: S3 lives outside the VPC. The instance's subnet needs
 * a route towards it: either a gateway endpoint (a prefix-list route, which
 * wins over 0.0.0.0/0) or a NAT Gateway sitting in a public subnet. A NAT
 * Gateway only ever carries connections that start inside the VPC. Once the
 * request arrives, S3 authorises the caller's IAM role.
 */
function instanceToBucketChecks(
  scene: Scene,
  instance: Ec2Instance,
  bucket: S3Bucket,
  action: ServiceAction,
  legs: { request: Leg; response: Leg },
): { request: PendingCheck[]; response: PendingCheck[] } {
  const subnet = requireSubnet(scene, instance.subnetId)
  const instanceIp = addressInSubnet(subnet)
  const s3Peer: ConnectionPeer = {
    ip: S3_ENDPOINT_ADDRESS,
    securityGroupIds: [],
    description: 'Amazon S3',
  }
  const route = resolveRoute(scene, subnet, 's3')

  const leaveInstance: PendingCheck[] = [
    () =>
      makeStep(
        legs.request,
        atResource(instance.id),
        'security-group',
        evaluateSecurityGroups(scene, instance.securityGroupIds, 'outbound', s3Peer, HTTPS_PORT),
      ),
    () => naclStep(scene, subnet, 'outbound', S3_ENDPOINT_ADDRESS, HTTPS_PORT, legs.request),
  ]
  const role = instance.roleId ? findResourceOfKind(scene, 'iam-role', instance.roleId) : undefined
  const authoriseCaller: PendingCheck = () => {
    const caller: Caller = role
      ? { kind: 'role', role }
      : { kind: 'no-credentials', description: `"${instance.name}"` }
    const { check, ...outcome } = evaluateBucketAccess(bucket, caller, action)
    return makeStep(legs.request, atResource(bucket.id), check, outcome)
  }
  // Once S3 has authorised the caller, an SSE-KMS bucket asks KMS to use its key on the
  // caller's behalf (kms.ts). Drawn at the bucket: the rain fizzles against the halo.
  const useKey: PendingCheck[] =
    role && needsKeyCheck(bucket, action)
      ? [
          () =>
            makeStep(
              legs.request,
              atResource(bucket.id),
              'kms',
              evaluateKeyUse(scene, bucket, role, action),
            ),
        ]
      : []
  const authorise = [authoriseCaller, ...useKey]
  const replyReachesInstance: PendingCheck = () =>
    naclStep(
      scene,
      subnet,
      'inbound',
      S3_ENDPOINT_ADDRESS,
      REPRESENTATIVE_EPHEMERAL_PORT,
      legs.response,
    )
  const routeFails = (explanation: string): PendingCheck[] => [
    () => makeStep(legs.request, atSubnet(subnet), 'route', { result: 'fail', explanation }),
  ]

  switch (route.kind) {
    case 'gateway-endpoint':
      return {
        request: [
          ...leaveInstance,
          () =>
            makeStep(legs.request, atSubnet(subnet), 'route', {
              result: 'pass',
              ruleRef: 'S3 prefix list → gateway endpoint',
              explanation: `The route table of "${subnet.name}" sends S3 traffic to a gateway endpoint. The prefix-list route is more specific than 0.0.0.0/0, so it wins, and the traffic never leaves the AWS network.`,
            }),
          ...authorise,
        ],
        response: [replyReachesInstance],
      }

    case 'nat-gateway': {
      const nat = route.natGateway
      const natSubnet = requireSubnet(scene, nat.subnetId)
      if (!isPublicSubnet(scene, natSubnet)) {
        return {
          request: [
            ...leaveInstance,
            ...routeFails(
              `The route table of "${subnet.name}" sends this to "${nat.name}", but that NAT Gateway sits in "${natSubnet.name}", which is not a public subnet. A NAT Gateway needs its own route to an Internet Gateway.`,
            ),
          ],
          response: [],
        }
      }
      if (subnetIsDown(scene, natSubnet)) {
        // AWS behaviour modelled: a NAT Gateway lives in one Availability Zone. If that
        // zone fails, private subnets routed to it lose their way out (ADR 0014).
        return {
          request: [
            ...leaveInstance,
            ...routeFails(
              `The route table of "${subnet.name}" sends this to "${nat.name}", but that NAT Gateway is in Availability Zone ${natSubnet.availabilityZone}, which is down. A NAT Gateway lives in one zone; a NAT Gateway in each zone avoids this.`,
            ),
          ],
          response: [],
        }
      }
      const crossesBoundary = natSubnet.id !== subnet.id
      return {
        request: [
          ...leaveInstance,
          () =>
            makeStep(legs.request, atSubnet(subnet), 'route', {
              result: 'pass',
              ruleRef: '0.0.0.0/0 → NAT Gateway',
              explanation: `The route table of "${subnet.name}" sends traffic for the internet to "${nat.name}".`,
            }),
          ...(crossesBoundary
            ? [() => naclStep(scene, natSubnet, 'inbound', instanceIp, HTTPS_PORT, legs.request)]
            : []),
          () =>
            naclStep(scene, natSubnet, 'outbound', S3_ENDPOINT_ADDRESS, HTTPS_PORT, legs.request),
          () =>
            makeStep(legs.request, atResource(nat.id), 'route', {
              result: 'pass',
              ruleRef: '0.0.0.0/0 → Internet Gateway',
              explanation: `"${nat.name}" forwards the connection out through the Internet Gateway, using its own public address. It carries outbound connections only.`,
            }),
          ...authorise,
        ],
        response: [
          () =>
            naclStep(
              scene,
              natSubnet,
              'inbound',
              S3_ENDPOINT_ADDRESS,
              REPRESENTATIVE_EPHEMERAL_PORT,
              legs.response,
            ),
          ...(crossesBoundary
            ? [
                () =>
                  naclStep(
                    scene,
                    natSubnet,
                    'outbound',
                    instanceIp,
                    REPRESENTATIVE_EPHEMERAL_PORT,
                    legs.response,
                  ),
              ]
            : []),
          replyReachesInstance,
        ],
      }
    }

    case 'internet-gateway':
      return {
        request: [
          ...leaveInstance,
          ...routeFails(
            `"${subnet.name}" routes to the Internet Gateway, but "${instance.name}" has only a private address. An Internet Gateway cannot carry traffic for something without a public address.`,
          ),
        ],
        response: [],
      }

    case 'blackhole':
      return {
        request: [
          ...leaveInstance,
          ...routeFails(`The route table of "${subnet.name}" leads nowhere: ${route.reason}.`),
        ],
        response: [],
      }

    case 'no-route':
    case 'local':
      return {
        request: [
          ...leaveInstance,
          ...routeFails(
            `The route table of "${subnet.name}" has only the local VPC route. S3 is outside the VPC, so there is no way to reach it: add a gateway endpoint or a route to a NAT Gateway.`,
          ),
        ],
        response: [],
      }
  }
}

// ---------------------------------------------------------------------------
// Journey 3: a kite from the ground straight to a bucket
// ---------------------------------------------------------------------------

function evaluateInternetToBucket(flow: Flow, bucket: S3Bucket): FlowResult {
  const trace: TraceStep[] = [
    makeStep('request', { kind: 'ground' }, 'route', {
      result: 'pass',
      explanation:
        'Amazon S3 lives outside the VPC and has its own public endpoint, so the kite flies straight to the bucket. The VPC gates, fences and outlines play no part.',
    }),
  ]
  const { check, ...outcome } = evaluateBucketAccess(
    bucket,
    { kind: 'anonymous' },
    flow.action ?? 's3:Read',
  )
  trace.push(makeStep('request', atResource(bucket.id), check, outcome))
  if (outcome.result === 'fail') return { outcome: 'blocked', trace }

  // A public bucket is fine when it holds a website, and a breach when it holds private data.
  if (flow.intent === 'hostile' && bucket.dataClass === 'sensitive') {
    trace.push(
      makeStep('request', atResource(bucket.id), 'delivery', {
        result: 'pass',
        explanation: `"${bucket.name}" holds sensitive data and is open to everyone. The attacker reads it: a breach.`,
      }),
    )
    return { outcome: 'breach', trace }
  }
  return {
    outcome: 'delivered',
    trace,
    responseTrace: [
      makeStep('response', { kind: 'ground' }, 'delivery', {
        result: 'pass',
        explanation: `"${bucket.name}" answers the request.`,
      }),
    ],
  }
}

// ---------------------------------------------------------------------------
// Journey 4: a kite from the ground aimed at something with no public address
// ---------------------------------------------------------------------------

/**
 * AWS behaviour modelled: resources in the game's mid band have private
 * addresses only. Private addresses are not routable from the internet, and an
 * Internet Gateway only translates for resources that hold a public address.
 */
function evaluateInternetToPrivateResource(name: string): FlowResult {
  return {
    outcome: 'blocked',
    trace: [
      makeStep('request', { kind: 'vpc' }, 'route', {
        result: 'fail',
        ruleRef: 'no public address',
        explanation: `"${name}" has only a private address (10.0.x.x). Nothing on the internet can route to a private address, so the kite drifts along the VPC border and finds no gate.`,
      }),
    ],
  }
}

// ---------------------------------------------------------------------------
// Journey 5: a kite from the ground to an instance with a public address
// ---------------------------------------------------------------------------

/**
 * AWS behaviour modelled: an instance with a public IPv4 address in a public subnet is
 * reachable from the internet through the Internet Gateway, subject to the subnet's
 * network ACL and then the instance's own security group. In the game only a bastion
 * host has a public address, and it runs only SSH (docs/SIMPLIFICATIONS.md).
 */
function publicInstanceEntryChecks(
  scene: Scene,
  instance: Ec2Instance,
  clientIp: string,
  port: number,
): PendingCheck[] {
  const subnet = requireSubnet(scene, instance.subnetId)
  const client: ConnectionPeer = {
    ip: clientIp,
    securityGroupIds: [],
    description: `the Cloudling at ${clientIp}`,
  }
  return [
    () =>
      isPublicSubnet(scene, subnet)
        ? makeStep('request', { kind: 'vpc' }, 'route', {
            result: 'pass',
            ruleRef: '0.0.0.0/0 → Internet Gateway',
            explanation: `"${instance.name}" has a public address in "${subnet.name}", a public subnet, so the Internet Gateway lets the kite into the VPC.`,
          })
        : makeStep('request', { kind: 'vpc' }, 'route', {
            result: 'fail',
            explanation: `"${instance.name}" has a public address, but "${subnet.name}" has no route sending 0.0.0.0/0 to an Internet Gateway, so nothing on the internet can reach it.`,
          }),
    () => naclStep(scene, subnet, 'inbound', clientIp, port, 'request'),
    () =>
      makeStep(
        'request',
        atResource(instance.id),
        'security-group',
        evaluateSecurityGroups(scene, instance.securityGroupIds, 'inbound', client, port),
      ),
  ]
}

function evaluateInternetToPublicInstance(
  scene: Scene,
  flow: Flow,
  clientIp: string,
  instance: Ec2Instance,
): FlowResult {
  const trace: TraceStep[] = []
  if (!runChecks(trace, publicInstanceEntryChecks(scene, instance, clientIp, flow.port)))
    return { outcome: 'blocked', trace }
  if (flow.port !== SSH_PORT) {
    trace.push(
      makeStep('request', atResource(instance.id), 'delivery', {
        result: 'fail',
        explanation: `Nothing on "${instance.name}" listens on ${describePort(flow.port)}: a bastion host runs only SSH.`,
      }),
    )
    return { outcome: 'dropped', trace }
  }
  // A hostile kite that reaches an open SSH port can start guessing: a breach.
  const breached = flow.intent === 'hostile'
  trace.push(
    makeStep('request', atResource(instance.id), 'delivery', {
      result: 'pass',
      explanation: breached
        ? `SSH on "${instance.name}" answered the probe. From here it can try passwords and stolen keys for as long as the port stays open.`
        : `SSH on "${instance.name}" answers.`,
    }),
  )
  if (breached) return { outcome: 'breach', trace }
  const subnet = requireSubnet(scene, instance.subnetId)
  const responseTrace: TraceStep[] = []
  const responded = runChecks(responseTrace, [
    () => naclStep(scene, subnet, 'outbound', clientIp, REPRESENTATIVE_EPHEMERAL_PORT, 'response'),
    () =>
      makeStep('response', { kind: 'ground' }, 'delivery', {
        result: 'pass',
        explanation: 'The reply leaves through the Internet Gateway and reaches the Cloudling.',
      }),
  ])
  return { outcome: responded ? 'delivered' : 'blocked', trace, responseTrace }
}

// ---------------------------------------------------------------------------
// Journey 6: the operator wants a shell on an instance
// ---------------------------------------------------------------------------

/**
 * With Session Manager in the sky the operator starts a session through it; without,
 * the operator connects by SSH: straight to an instance with a public address, or
 * through a bastion host to one with only a private address.
 */
function evaluateShell(
  scene: Scene,
  flow: Flow,
  clientIp: string,
  instance: Ec2Instance,
): FlowResult {
  const sessionManager = resourcesOfKind(scene, 'session-manager')[0]
  if (sessionManager) return evaluateSession(scene, instance, sessionManager)
  if (instance.publicAddress)
    return evaluateInternetToPublicInstance(scene, { ...flow, port: SSH_PORT }, clientIp, instance)
  const jumpHost = flow.shell?.jumpHostId
    ? findResourceOfKind(scene, 'ec2-instance', flow.shell.jumpHostId)
    : undefined
  if (!jumpHost?.publicAddress) {
    return {
      outcome: 'blocked',
      trace: [
        makeStep('request', { kind: 'vpc' }, 'route', {
          result: 'fail',
          ruleRef: 'no public address',
          explanation: `"${instance.name}" has only a private address, so nothing on the internet can reach it, by SSH or any other way, and there is no bastion host to step through. The operator has no way in.`,
        }),
      ],
    }
  }
  return evaluateSshThroughBastion(scene, clientIp, jumpHost, instance)
}

/**
 * AWS behaviour modelled: SSH through a bastion host is two connections. The operator
 * connects to the bastion's public address on port 22; the bastion then opens its own
 * connection to the private instance on port 22. Each crosses the network ACLs on its
 * way and the security groups at each end: the bastion's group must let it out, and the
 * instance's group must let the bastion in. Replies cross every network ACL again.
 */
function evaluateSshThroughBastion(
  scene: Scene,
  clientIp: string,
  bastion: Ec2Instance,
  target: Ec2Instance,
): FlowResult {
  const bastionSubnet = requireSubnet(scene, bastion.subnetId)
  const targetSubnet = requireSubnet(scene, target.subnetId)
  const bastionIp = addressInSubnet(bastionSubnet)
  const targetIp = addressInSubnet(targetSubnet)
  const crosses = bastionSubnet.id !== targetSubnet.id
  const trace: TraceStep[] = []
  const reached = runChecks(trace, [
    ...publicInstanceEntryChecks(scene, bastion, clientIp, SSH_PORT),
    () =>
      makeStep(
        'request',
        atResource(bastion.id),
        'security-group',
        evaluateSecurityGroups(
          scene,
          bastion.securityGroupIds,
          'outbound',
          instancePeer(scene, target),
          SSH_PORT,
        ),
      ),
    ...(crosses
      ? [
          () => naclStep(scene, bastionSubnet, 'outbound', targetIp, SSH_PORT, 'request'),
          () => naclStep(scene, targetSubnet, 'inbound', bastionIp, SSH_PORT, 'request'),
        ]
      : []),
    () =>
      makeStep(
        'request',
        atResource(target.id),
        'security-group',
        evaluateSecurityGroups(
          scene,
          target.securityGroupIds,
          'inbound',
          instancePeer(scene, bastion),
          SSH_PORT,
        ),
      ),
  ])
  if (!reached) return { outcome: 'blocked', trace }
  if (!target.healthy) {
    trace.push(
      makeStep('request', atResource(target.id), 'delivery', {
        result: 'fail',
        explanation: `"${target.name}" is not running, so nothing answers.`,
      }),
    )
    return { outcome: 'dropped', trace }
  }
  trace.push(
    makeStep('request', atResource(target.id), 'delivery', {
      result: 'pass',
      explanation: `SSH answers on "${target.name}": the operator has a shell, stepping through "${bastion.name}". It took a public machine with port 22 open, and a private key that must be kept safe.`,
    }),
  )
  const responseTrace: TraceStep[] = []
  const responded = runChecks(responseTrace, [
    ...(crosses
      ? [
          () =>
            naclStep(
              scene,
              targetSubnet,
              'outbound',
              bastionIp,
              REPRESENTATIVE_EPHEMERAL_PORT,
              'response',
            ),
          () =>
            naclStep(
              scene,
              bastionSubnet,
              'inbound',
              targetIp,
              REPRESENTATIVE_EPHEMERAL_PORT,
              'response',
            ),
        ]
      : []),
    () =>
      naclStep(
        scene,
        bastionSubnet,
        'outbound',
        clientIp,
        REPRESENTATIVE_EPHEMERAL_PORT,
        'response',
      ),
    () =>
      makeStep('response', { kind: 'ground' }, 'delivery', {
        result: 'pass',
        explanation: 'The reply leaves through the Internet Gateway and reaches the operator.',
      }),
  ])
  return { outcome: responded ? 'delivered' : 'blocked', trace, responseTrace }
}

// ---------------------------------------------------------------------------
// Journey 7: a session through Session Manager
// ---------------------------------------------------------------------------

/**
 * AWS behaviour modelled: Session Manager reaches managed instances only. An EC2
 * instance becomes one when its SSM Agent registers with Systems Manager, using the
 * credentials of the instance's IAM role, and it must allow HTTPS (443) out to the
 * Systems Manager endpoints. The agent keeps that outbound connection open, and
 * sessions run over it, so the instance needs no inbound port, no public address and
 * no SSH key. The operator reaches Systems Manager over HTTPS with their own IAM
 * identity (assumed allowed; docs/SIMPLIFICATIONS.md).
 *
 * Trace order: the operator's request reaches Session Manager and comes down to the
 * instance, then the agent's outbound connection is checked, out and back. In AWS the
 * agent connects first; this order is the one a player can follow in the sky.
 */
function evaluateSession(
  scene: Scene,
  instance: Ec2Instance,
  sessionManager: SessionManager,
): FlowResult {
  const trace: TraceStep[] = [
    makeStep('request', atResource(sessionManager.id), 'route', {
      result: 'pass',
      ruleRef: 'HTTPS to Systems Manager',
      explanation: `The operator asks "${sessionManager.name}" for a shell on "${instance.name}", over HTTPS and signed with their own IAM identity. Nothing connects to the instance itself.`,
    }),
  ]
  const role = instance.roleId ? findResourceOfKind(scene, 'iam-role', instance.roleId) : undefined
  if (!runChecks(trace, [() => managedInstanceStep(instance, role, sessionManager)]))
    return { outcome: 'blocked', trace }
  if (!instance.healthy) {
    trace.push(
      makeStep('request', atResource(instance.id), 'delivery', {
        result: 'fail',
        explanation: `"${instance.name}" is not running, so its SSM Agent is offline.`,
      }),
    )
    return { outcome: 'dropped', trace }
  }
  const channel = agentChannelChecks(scene, instance, sessionManager)
  if (!runChecks(trace, channel.request)) return { outcome: 'blocked', trace }
  const responseTrace: TraceStep[] = []
  const opened = runChecks(responseTrace, [
    ...channel.response,
    () =>
      makeStep('backend-response', atResource(instance.id), 'delivery', {
        result: 'pass',
        explanation: `"${sessionManager.name}" joins the operator to the SSM Agent's own connection: a shell on "${instance.name}", with no inbound port open.`,
      }),
  ])
  return { outcome: opened ? 'delivered' : 'blocked', trace, responseTrace }
}

/** May the SSM Agent register? The instance's role must allow ssm:ManagedInstance. */
function managedInstanceStep(
  instance: Ec2Instance,
  role: IamRole | undefined,
  sessionManager: SessionManager,
): TraceStep {
  const at = atResource(instance.id)
  if (!role) {
    return makeStep('request', at, 'iam', {
      result: 'fail',
      ruleRef: 'no IAM role',
      explanation: `"${instance.name}" has no IAM role, so its SSM Agent has no credentials to register with Systems Manager. Session Manager reaches only managed instances.`,
    })
  }
  const decision = evaluateIdentityPolicy(role, 'ssm:ManagedInstance', sessionManager.id)
  if (decision.verdict === 'explicit-deny') {
    return makeStep('request', at, 'iam', {
      result: 'fail',
      ruleRef: `role "${role.name}": explicit deny ssm:ManagedInstance`,
      explanation: `Role "${role.name}" explicitly denies ssm:ManagedInstance, and an explicit deny overrides every allow, so the SSM Agent on "${instance.name}" cannot register.`,
    })
  }
  if (decision.verdict === 'allow') {
    return makeStep('request', at, 'iam', {
      result: 'pass',
      ruleRef: `role "${role.name}": allow ssm:ManagedInstance`,
      matched: {
        kind: 'role-statement',
        roleId: role.id,
        index: decision.index,
        action: 'ssm:ManagedInstance',
        resourceId: sessionManager.id,
      },
      explanation: `Role "${role.name}" allows ssm:ManagedInstance, so the SSM Agent on "${instance.name}" can register with Systems Manager: it is a managed instance.`,
    })
  }
  return makeStep('request', at, 'iam', {
    result: 'fail',
    ruleRef: 'implicit deny: no ssm:ManagedInstance',
    explanation: `Session Manager reaches only managed instances. Role "${role.name}" does not allow ssm:ManagedInstance, so the SSM Agent on "${instance.name}" cannot register with Systems Manager.`,
  })
}

/**
 * The SSM Agent's connection out to the Systems Manager endpoints: HTTPS 443, out
 * through the instance's security group and its subnet's network ACL, then by its
 * subnet's route to the internet. From a private subnet that is a NAT Gateway in a
 * public subnet, whose own subnet's network ACL the connection crosses both ways.
 */
function agentChannelChecks(
  scene: Scene,
  instance: Ec2Instance,
  sessionManager: SessionManager,
): { request: PendingCheck[]; response: PendingCheck[] } {
  const leg: Leg = 'backend-request'
  const back: Leg = 'backend-response'
  const subnet = requireSubnet(scene, instance.subnetId)
  const instanceIp = addressInSubnet(subnet)
  const endpoints: ConnectionPeer = {
    ip: SSM_ENDPOINT_ADDRESS,
    securityGroupIds: [],
    description: 'the Systems Manager endpoints',
  }
  const leaveInstance: PendingCheck[] = [
    () =>
      makeStep(
        leg,
        atResource(instance.id),
        'security-group',
        evaluateSecurityGroups(scene, instance.securityGroupIds, 'outbound', endpoints, HTTPS_PORT),
      ),
    () => naclStep(scene, subnet, 'outbound', SSM_ENDPOINT_ADDRESS, HTTPS_PORT, leg),
  ]
  const reachEndpoints: PendingCheck = () =>
    makeStep(leg, atResource(sessionManager.id), 'delivery', {
      result: 'pass',
      explanation: `The SSM Agent on "${instance.name}" reaches the Systems Manager endpoints over HTTPS 443 and keeps the connection open, ready for sessions.`,
    })
  const replyReachesInstance: PendingCheck = () =>
    naclStep(scene, subnet, 'inbound', SSM_ENDPOINT_ADDRESS, REPRESENTATIVE_EPHEMERAL_PORT, back)
  const routeFails = (explanation: string): PendingCheck[] => [
    () => makeStep(leg, atSubnet(subnet), 'route', { result: 'fail', explanation }),
  ]
  const route = resolveRoute(scene, subnet, 'internet')

  switch (route.kind) {
    case 'nat-gateway': {
      const nat = route.natGateway
      const natSubnet = requireSubnet(scene, nat.subnetId)
      if (!isPublicSubnet(scene, natSubnet) || subnetIsDown(scene, natSubnet)) {
        return {
          request: [
            ...leaveInstance,
            ...routeFails(
              `The route table of "${subnet.name}" sends this to "${nat.name}", but that NAT Gateway cannot reach the internet from "${natSubnet.name}".`,
            ),
          ],
          response: [],
        }
      }
      const crossesBoundary = natSubnet.id !== subnet.id
      return {
        request: [
          ...leaveInstance,
          () =>
            makeStep(leg, atSubnet(subnet), 'route', {
              result: 'pass',
              ruleRef: '0.0.0.0/0 → NAT Gateway',
              explanation: `The route table of "${subnet.name}" sends traffic for the internet to "${nat.name}".`,
            }),
          ...(crossesBoundary
            ? [() => naclStep(scene, natSubnet, 'inbound', instanceIp, HTTPS_PORT, leg)]
            : []),
          () => naclStep(scene, natSubnet, 'outbound', SSM_ENDPOINT_ADDRESS, HTTPS_PORT, leg),
          () =>
            makeStep(leg, atResource(nat.id), 'route', {
              result: 'pass',
              ruleRef: '0.0.0.0/0 → Internet Gateway',
              explanation: `"${nat.name}" forwards the agent's connection out through the Internet Gateway, using its own public address. It carries outbound connections only: nothing outside can start one in.`,
            }),
          reachEndpoints,
        ],
        response: [
          () =>
            naclStep(
              scene,
              natSubnet,
              'inbound',
              SSM_ENDPOINT_ADDRESS,
              REPRESENTATIVE_EPHEMERAL_PORT,
              back,
            ),
          ...(crossesBoundary
            ? [
                () =>
                  naclStep(
                    scene,
                    natSubnet,
                    'outbound',
                    instanceIp,
                    REPRESENTATIVE_EPHEMERAL_PORT,
                    back,
                  ),
              ]
            : []),
          replyReachesInstance,
        ],
      }
    }

    case 'internet-gateway':
      if (instance.publicAddress) {
        return {
          request: [
            ...leaveInstance,
            () =>
              makeStep(leg, atSubnet(subnet), 'route', {
                result: 'pass',
                ruleRef: '0.0.0.0/0 → Internet Gateway',
                explanation: `"${instance.name}" has a public address, so its connection leaves straight through the Internet Gateway.`,
              }),
            reachEndpoints,
          ],
          response: [replyReachesInstance],
        }
      }
      return {
        request: [
          ...leaveInstance,
          ...routeFails(
            `"${subnet.name}" routes to the Internet Gateway, but "${instance.name}" has only a private address, which an Internet Gateway cannot carry. A NAT Gateway can.`,
          ),
        ],
        response: [],
      }

    case 'blackhole':
      return {
        request: [
          ...leaveInstance,
          ...routeFails(`The route table of "${subnet.name}" leads nowhere: ${route.reason}.`),
        ],
        response: [],
      }

    case 'gateway-endpoint':
    case 'no-route':
    case 'local':
      return {
        request: [
          ...leaveInstance,
          ...routeFails(
            `The route table of "${subnet.name}" has no route to the internet, so the SSM Agent on "${instance.name}" cannot reach the Systems Manager endpoints on HTTPS 443. A gateway endpoint carries only S3 and DynamoDB; a NAT Gateway in a public subnet would carry the agent's connection out.`,
          ),
        ],
        response: [],
      }
  }
}

/**
 * What a database's encryption at rest means for a query. RDS uses the key itself,
 * so the application connecting to it needs no KMS permission (docs/ENGINE.md, section 17).
 */
function atRestNote(scene: Scene, database: RdsDatabase): string {
  const encryption = database.encryption
  if (encryption.kind === 'none')
    return ' Its storage is not encrypted at rest, and RDS can only encrypt a database when it is created.'
  const key =
    encryption.keyId === null
      ? 'the AWS managed key aws/rds'
      : `"${findResourceOfKind(scene, 'kms-key', encryption.keyId)?.name ?? encryption.keyId}"`
  return ` Its storage is encrypted at rest with ${key}; RDS uses the key itself, so the application needs no KMS permission.`
}
