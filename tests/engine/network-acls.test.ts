// Network ACL rules.
//
// AWS documentation these tests are based on:
// - Network ACLs (stateless; one per subnet; default vs custom):
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html
// - Network ACL rules (numbered, lowest first, first match wins, final * deny):
//   https://docs.aws.amazon.com/vpc/latest/userguide/nacl-rules.html
// - Ephemeral ports:
//   https://docs.aws.amazon.com/vpc/latest/userguide/nacl-ephemeral-ports.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  evaluateNetworkAcl,
  failingStep,
  type NetworkAcl,
  type NetworkAclRule,
} from '../../src/engine'
import { BAD_RANGE_IP, byId, GREEN_IP, sceneWith, webRequest, workingScene } from './fixtures'

const rule = (
  number: number,
  action: 'allow' | 'deny',
  ports: NetworkAclRule['ports'],
  cidr?: string,
): NetworkAclRule => ({
  number,
  action,
  ports,
  peer: cidr ? { kind: 'cidr', cidr } : { kind: 'anywhere' },
})

const acl = (inbound: NetworkAclRule[], outbound: NetworkAclRule[] = []): NetworkAcl => ({
  id: 'nacl-custom',
  name: 'Custom NACL',
  inbound,
  outbound,
})

/** Puts a custom NACL on both public subnets (where the load balancer lives). */
const withPublicAcl = (custom: NetworkAcl) =>
  sceneWith((s) => {
    s.networkAcls.push(custom)
    byId(s.subnets, 'public-a').networkAclId = custom.id
    byId(s.subnets, 'public-b').networkAclId = custom.id
  })

describe('rule order', () => {
  it('evaluates the lowest rule number first and stops at the first match', () => {
    const denyFirst = acl([rule(90, 'deny', 'all', '198.51.100.0/24'), rule(100, 'allow', 'https')])
    expect(evaluateNetworkAcl(denyFirst, 'inbound', BAD_RANGE_IP, 443).result).toBe('fail')
    expect(evaluateNetworkAcl(denyFirst, 'inbound', BAD_RANGE_IP, 443).ruleRef).toBe(
      'NACL rule 90 (deny)',
    )

    // The same two rules with the numbers swapped: the allow now matches first, so the deny never runs.
    const allowFirst = acl([
      rule(100, 'deny', 'all', '198.51.100.0/24'),
      rule(90, 'allow', 'https'),
    ])
    expect(evaluateNetworkAcl(allowFirst, 'inbound', BAD_RANGE_IP, 443).result).toBe('pass')
  })

  it('orders by rule number, not by position in the list', () => {
    const shuffled = acl([rule(100, 'allow', 'https'), rule(90, 'deny', 'all', '198.51.100.0/24')])
    expect(evaluateNetworkAcl(shuffled, 'inbound', BAD_RANGE_IP, 443).result).toBe('fail')
  })

  it('denies with the final * rule when nothing matches', () => {
    const result = evaluateNetworkAcl(acl([rule(100, 'allow', 'https')]), 'inbound', GREEN_IP, 22)
    expect(result.result).toBe('fail')
    expect(result.ruleRef).toBe('NACL rule * (deny)')
  })
})

describe('default and custom ACLs', () => {
  it('allows everything both ways with the default NACL', () => {
    expect(evaluateFlow(workingScene(), webRequest()).outcome).toBe('delivered')
  })

  it('denies everything with a new custom NACL until rules are added', () => {
    const result = evaluateFlow(withPublicAcl(acl([], [])), webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('nacl')
    expect(failingStep(result)?.at).toEqual({ kind: 'subnet', id: 'public-a' })
  })

  it('can deny one source range while allowing everyone else, which a security group cannot', () => {
    const scene = withPublicAcl(
      acl(
        [rule(90, 'deny', 'all', '198.51.100.0/24'), rule(100, 'allow', 'all')],
        [rule(100, 'allow', 'all')],
      ),
    )
    expect(evaluateFlow(scene, webRequest()).outcome).toBe('delivered')
    const bad = evaluateFlow(
      scene,
      webRequest({ source: { kind: 'internet', ip: BAD_RANGE_IP }, intent: 'hostile' }),
    )
    expect(bad.outcome).toBe('blocked')
    expect(failingStep(bad)?.ruleRef).toBe('NACL rule 90 (deny)')
  })
})

describe('statelessness', () => {
  // Inbound: HTTPS from the internet, plus replies from the targets on ephemeral ports.
  const inbound = [rule(100, 'allow', 'https'), rule(110, 'allow', 'ephemeral', '10.0.0.0/16')]

  it('lets the request in but drops the response when no outbound rule covers ephemeral ports', () => {
    // Outbound allows HTTP towards the targets, but nothing back to the client.
    const scene = withPublicAcl(acl(inbound, [rule(100, 'allow', 'http', '10.0.0.0/16')]))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(result.trace.every((step) => step.result === 'pass')).toBe(true) // the request arrived
    const failed = failingStep(result)
    expect(failed?.leg).toBe('response')
    expect(failed?.check).toBe('nacl')
    expect(failed?.at).toEqual({ kind: 'subnet', id: 'public-a' })
  })

  it('delivers once outbound ephemeral ports are allowed', () => {
    const scene = withPublicAcl(
      acl(inbound, [rule(100, 'allow', 'http', '10.0.0.0/16'), rule(110, 'allow', 'ephemeral')]),
    )
    expect(evaluateFlow(scene, webRequest()).outcome).toBe('delivered')
  })

  it("judges the target's reply afresh at the load balancer subnet boundary", () => {
    // No inbound rule for ephemeral ports: the target's reply cannot re-enter the public subnet.
    const scene = withPublicAcl(
      acl(
        [rule(100, 'allow', 'https')],
        [rule(100, 'allow', 'http', '10.0.0.0/16'), rule(110, 'allow', 'ephemeral')],
      ),
    )
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.leg).toBe('response')
  })
})

describe('subnet boundaries', () => {
  it('does not filter traffic between two resources in the same subnet', () => {
    // The public NACL has no rule for HTTP 80 at all. A target placed in the same
    // subnet as the load balancer node is still reached, because nothing crosses the boundary.
    const scene = withPublicAcl(
      acl([rule(100, 'allow', 'https')], [rule(100, 'allow', 'ephemeral')]),
    )
    const instance = byId(scene.resources, 'app-a')
    if (instance.kind === 'ec2-instance') instance.subnetId = 'public-a'
    const loadBalancer = byId(scene.resources, 'alb')
    if (loadBalancer.kind === 'load-balancer') loadBalancer.targetIds = ['app-a']
    const result = evaluateFlow(scene, webRequest({ sequence: 0 })) // sequence 0 uses the node in public-a
    expect(result.outcome).toBe('delivered')
  })
})
