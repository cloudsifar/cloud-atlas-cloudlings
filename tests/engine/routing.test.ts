// Routing rules.
//
// AWS documentation these tests are based on:
// - Route tables and the implicit local route:
//   https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html
// - Route priority (longest prefix match; prefix lists):
//   https://docs.aws.amazon.com/vpc/latest/userguide/route-tables-priority.html
// - Internet gateways and what makes a subnet public:
//   https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html
// - NAT gateways:
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html
// - Gateway endpoints (S3 and DynamoDB only, route-table based, no charge):
//   https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  failingStep,
  isPublicSubnet,
  resolveRoute,
  type Scene,
} from '../../src/engine'
import { byId, GREEN_IP, sceneWith, uploadRequest, webRequest, workingScene } from './fixtures'

const subnet = (scene: Scene, id: string) => byId(scene.subnets, id)

describe('route selection', () => {
  it('always has a local route for the VPC, even in an empty route table', () => {
    const scene = sceneWith((s) => (byId(s.routeTables, 'rt-private').routes = []))
    expect(resolveRoute(scene, subnet(scene, 'private-a'), 'vpc')).toEqual({ kind: 'local' })
  })

  it('has no route to the internet unless one is added', () => {
    const scene = sceneWith((s) => (byId(s.routeTables, 'rt-private').routes = []))
    expect(resolveRoute(scene, subnet(scene, 'private-a'), 'internet').kind).toBe('no-route')
    expect(resolveRoute(scene, subnet(scene, 'private-a'), 's3').kind).toBe('no-route')
  })

  it('uses 0.0.0.0/0 for S3 when there is no more specific route', () => {
    const scene = workingScene()
    expect(resolveRoute(scene, subnet(scene, 'private-a'), 's3').kind).toBe('nat-gateway')
  })

  it('prefers a prefix-list route over 0.0.0.0/0, whatever order they were added in', () => {
    const endpoint = {
      destination: 's3',
      target: { kind: 'gateway-endpoint', service: 's3' },
    } as const
    const after = sceneWith((s) => byId(s.routeTables, 'rt-private').routes.push(endpoint))
    const before = sceneWith((s) => byId(s.routeTables, 'rt-private').routes.unshift(endpoint))
    for (const scene of [after, before]) {
      expect(resolveRoute(scene, subnet(scene, 'private-a'), 's3')).toEqual({
        kind: 'gateway-endpoint',
        service: 's3',
      })
      // Only S3 traffic takes the endpoint; everything else still follows 0.0.0.0/0.
      expect(resolveRoute(scene, subnet(scene, 'private-a'), 'internet').kind).toBe('nat-gateway')
      expect(resolveRoute(scene, subnet(scene, 'private-a'), 'dynamodb').kind).toBe('nat-gateway')
    }
  })

  it('reports a blackhole when a route names a NAT Gateway that has gone', () => {
    const scene = sceneWith((s) => (s.resources = s.resources.filter((r) => r.id !== 'nat')))
    expect(resolveRoute(scene, subnet(scene, 'private-a'), 'internet').kind).toBe('blackhole')
  })
})

describe('public subnets', () => {
  it('is public if and only if 0.0.0.0/0 goes to an attached Internet Gateway', () => {
    const scene = workingScene()
    expect(isPublicSubnet(scene, subnet(scene, 'public-a'))).toBe(true)
    expect(isPublicSubnet(scene, subnet(scene, 'private-a'))).toBe(false) // routes to a NAT Gateway
  })

  it('is not public when the route exists but no Internet Gateway is attached', () => {
    const scene = sceneWith((s) => (s.resources = s.resources.filter((r) => r.id !== 'igw')))
    expect(isPublicSubnet(scene, subnet(scene, 'public-a'))).toBe(false)
  })

  it('is not public when the Internet Gateway is attached but the route is missing', () => {
    const scene = sceneWith((s) => (byId(s.routeTables, 'rt-public').routes = []))
    expect(isPublicSubnet(scene, subnet(scene, 'public-a'))).toBe(false)
  })
})

describe('inbound from the internet', () => {
  it('reaches an internet-facing load balancer in public subnets', () => {
    expect(evaluateFlow(workingScene(), webRequest()).outcome).toBe('delivered')
  })

  it('finds no gate when the load balancer subnet has no route to the Internet Gateway', () => {
    const scene = sceneWith((s) => (byId(s.routeTables, 'rt-public').routes = []))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('route')
    expect(failingStep(result)?.at).toEqual({ kind: 'vpc' })
  })

  it('can never reach an instance directly: private addresses are not routable from the internet', () => {
    const result = evaluateFlow(workingScene(), {
      ...webRequest(),
      destination: { kind: 'resource', id: 'app-a' },
      intent: 'hostile',
    })
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('route')
  })

  it('never comes in through a NAT Gateway, even when every security group is wide open', () => {
    const scene = sceneWith((s) => {
      byId(s.securityGroups, 'sg-app').inbound = [{ ports: 'all', peer: { kind: 'anywhere' } }]
    })
    const result = evaluateFlow(scene, {
      id: 'red',
      source: { kind: 'internet', ip: GREEN_IP },
      destination: { kind: 'resource', id: 'app-a' },
      port: 22,
      payload: 'clean',
      intent: 'hostile',
    })
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('route')
  })
})

describe('outbound from a private subnet to S3', () => {
  it('goes out through a NAT Gateway in a public subnet', () => {
    const result = evaluateFlow(workingScene(), uploadRequest())
    expect(result.outcome).toBe('delivered')
    expect(result.trace.map((step) => step.ruleRef)).toContain('0.0.0.0/0 → NAT Gateway')
  })

  it('fails when the NAT Gateway sits in a subnet that is not public', () => {
    const scene = sceneWith((s) => {
      const nat = byId(s.resources, 'nat')
      if (nat.kind === 'nat-gateway') nat.subnetId = 'private-b'
    })
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('route')
    expect(failingStep(result)?.leg).toBe('backend-request')
  })

  it('fails with only the local route', () => {
    const scene = sceneWith((s) => (byId(s.routeTables, 'rt-private').routes = []))
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('route')
  })

  it('works through a gateway endpoint with no NAT Gateway at all', () => {
    const scene = sceneWith((s) => {
      s.resources = s.resources.filter((r) => r.id !== 'nat')
      byId(s.routeTables, 'rt-private').routes = [
        { destination: 's3', target: { kind: 'gateway-endpoint', service: 's3' } },
      ]
    })
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('delivered')
    expect(result.trace.map((step) => step.ruleRef)).toContain('S3 prefix list → gateway endpoint')
  })

  it('fails when a private instance is routed straight at the Internet Gateway: it has no public address', () => {
    const scene = sceneWith((s) => {
      byId(s.routeTables, 'rt-private').routes = [
        { destination: 'internet', target: { kind: 'internet-gateway' } },
      ]
    })
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.explanation).toMatch('private address')
  })
})
