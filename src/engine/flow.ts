// evaluateFlow: what happens to this flow in this scene?
//
// This file is the engine's front door. It decides which journey a flow takes,
// then walks that journey as an ordered list of checks. Each check is a small
// function returning one TraceStep; the walk stops at the first failure.
// The rules themselves live in the rule modules (routing, securityGroups,
// networkAcls, iam, s3); this file only puts them in the order AWS applies them.

import { addressInSubnet, S3_ENDPOINT_ADDRESS } from './address'
import {
  findResource,
  findResourceOfKind,
  requireNetworkAcl,
  requireSubnet,
  type Ec2Instance,
  type LoadBalancer,
  type S3Bucket,
  type Scene,
  type ServiceAction,
  type Subnet,
} from './model'
import { evaluateNetworkAcl } from './networkAcls'
import { describePort, HTTP_PORT, HTTPS_PORT, REPRESENTATIVE_EPHEMERAL_PORT } from './ports'
import { isPublicSubnet, resolveRoute } from './routing'
import { evaluateBucketAccess, type Caller } from './s3'
import { evaluateSecurityGroups, type ConnectionPeer } from './securityGroups'
import type { CheckKind, CheckOutcome, Flow, FlowResult, Leg, ResourceRef, TraceStep } from './trace'

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
export function evaluateFlow(scene: Scene, flow: Flow): FlowResult {
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
  const nodeCount = Math.max(loadBalancer.subnetIds.length, 1)

  // A load balancer has one node per subnet. DNS spreads clients across the nodes;
  // we rotate through them by sequence so the choice is repeatable.
  const nodeSubnetId = loadBalancer.subnetIds[sequence % nodeCount]
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
  // load balancer's subnet -> the load balancer's security group -> its listener.
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
    trace.push(
      makeStep('request', atResource(target.id), 'delivery', {
        result: 'fail',
        explanation: `"${target.name}" is not running, so nothing answers and the request times out.`,
      }),
    )
    return { outcome: 'dropped', trace }
  }
  const breached = flow.intent === 'hostile' && flow.payload === 'malicious'
  trace.push(
    makeStep('request', atResource(target.id), 'delivery', {
      result: 'pass',
      explanation: breached
        ? `A malicious request reached "${target.name}". Nothing on the way inspected what the kite was carrying.`
        : `The request reaches "${target.name}" on ${describePort(TARGET_PORT)}.`,
    }),
  )
  if (breached) return { outcome: 'breach', trace }

  // Any work the application does before it can answer (e.g. storing an upload).
  if (flow.backendCall) {
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
    const call = instanceToBucketChecks(scene, target, bucket, flow.backendCall.action, {
      request: 'backend-request',
      response: 'backend-response',
    })
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
function internetRouteStep(scene: Scene, loadBalancer: LoadBalancer, nodeSubnet: Subnet): TraceStep {
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
  const authorise: PendingCheck = () => {
    const role = instance.roleId ? findResourceOfKind(scene, 'iam-role', instance.roleId) : undefined
    const caller: Caller = role
      ? { kind: 'role', role }
      : { kind: 'no-credentials', description: `"${instance.name}"` }
    const { check, ...outcome } = evaluateBucketAccess(bucket, caller, action)
    return makeStep(legs.request, atResource(bucket.id), check, outcome)
  }
  const replyReachesInstance: PendingCheck = () =>
    naclStep(scene, subnet, 'inbound', S3_ENDPOINT_ADDRESS, REPRESENTATIVE_EPHEMERAL_PORT, legs.response)
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
          authorise,
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
          () => naclStep(scene, natSubnet, 'outbound', S3_ENDPOINT_ADDRESS, HTTPS_PORT, legs.request),
          () =>
            makeStep(legs.request, atResource(nat.id), 'route', {
              result: 'pass',
              ruleRef: '0.0.0.0/0 → Internet Gateway',
              explanation: `"${nat.name}" forwards the connection out through the Internet Gateway, using its own public address. It carries outbound connections only.`,
            }),
          authorise,
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
  const { check, ...outcome } = evaluateBucketAccess(bucket, { kind: 'anonymous' }, flow.action ?? 's3:Read')
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
