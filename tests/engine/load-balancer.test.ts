// Application Load Balancer behaviour.
//
// AWS documentation these tests are based on:
// - What an Application Load Balancer is (listeners, targets, cross-zone on by default):
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html
// - Target group health checks (only healthy targets; fail open when none is healthy):
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html
// - Routing algorithm (round robin by default):
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html
// - Troubleshooting (HTTP 503 when a target group has no registered targets):
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  failingStep,
  type Ec2Instance,
  type LoadBalancer,
  type Scene,
} from '../../src/engine'
import { byId, sceneWith, webRequest, workingScene } from './fixtures'

const loadBalancer = (scene: Scene) => byId(scene.resources, 'alb') as LoadBalancer
const instance = (scene: Scene, id: string) => byId(scene.resources, id) as Ec2Instance

/** Which target served the request: the resource of the delivery step. */
const servedBy = (scene: Scene, sequence: number): string | undefined => {
  const step = evaluateFlow(scene, webRequest({ sequence })).trace.find(
    (s) => s.check === 'delivery',
  )
  return step?.at.kind === 'resource' ? step.at.id : undefined
}

describe('listener', () => {
  it('accepts requests on the listener port only', () => {
    const http = sceneWith((s) => {
      loadBalancer(s).listener = 'http'
      byId(s.securityGroups, 'sg-alb').inbound = [{ ports: 'all', peer: { kind: 'anywhere' } }]
    })
    const result = evaluateFlow(http, webRequest({ port: 443 }))
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('listener')
    expect(evaluateFlow(http, webRequest({ port: 80 })).outcome).toBe('delivered')
  })

  it('is unreachable from the internet when the scheme is internal', () => {
    const scene = sceneWith((s) => (loadBalancer(s).scheme = 'internal'))
    expect(failingStep(evaluateFlow(scene, webRequest()))?.check).toBe('route')
  })
})

describe('target selection', () => {
  it('takes turns between healthy targets, in both Availability Zones', () => {
    const scene = workingScene()
    const served = [0, 1, 2, 3].map((sequence) => servedBy(scene, sequence))
    expect(new Set(served)).toEqual(new Set(['app-a', 'app-b']))
  })

  it('answers 503 itself when no targets are registered', () => {
    const scene = sceneWith((s) => (loadBalancer(s).targetIds = []))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('dropped')
    expect(failingStep(result)?.check).toBe('target-selection')
  })

  it('skips a failed instance while another target is healthy', () => {
    const scene = sceneWith((s) => (instance(s, 'app-a').healthy = false))
    for (const sequence of [0, 1, 2, 3]) expect(servedBy(scene, sequence)).toBe('app-b')
  })

  it('treats a target it cannot reach over the network as unhealthy', () => {
    // app-a moves to a security group that does not admit the load balancer.
    const scene = sceneWith((s) => {
      s.securityGroups.push({ id: 'sg-closed', name: 'closed', inbound: [], outbound: [] })
      instance(s, 'app-a').securityGroupIds = ['sg-closed']
    })
    for (const sequence of [0, 1, 2, 3]) expect(servedBy(scene, sequence)).toBe('app-b')
  })

  it('fails open when every target is unhealthy, and the request then times out at a dead instance', () => {
    const scene = sceneWith((s) => {
      instance(s, 'app-a').healthy = false
      instance(s, 'app-b').healthy = false
    })
    const result = evaluateFlow(scene, webRequest())
    expect(result.trace.find((step) => step.check === 'target-selection')?.ruleRef).toBe(
      'fail open: no healthy targets',
    )
    expect(result.outcome).toBe('dropped')
    expect(failingStep(result)?.check).toBe('delivery')
  })
})

describe('malicious payloads', () => {
  it('is a breach when a hostile, malicious request reaches an instance (nothing here inspects payloads)', () => {
    const result = evaluateFlow(
      workingScene(),
      webRequest({ intent: 'hostile', payload: 'malicious' }),
    )
    expect(result.outcome).toBe('breach')
  })
})
