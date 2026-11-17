// Security group rules.
//
// AWS documentation these tests are based on:
// - Security groups (stateful; allow rules only; all rules evaluated):
//   https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html
// - Security group rules (sources: CIDR or another security group; defaults):
//   https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html
// - Security groups for an Application Load Balancer and its targets:
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-update-security-groups.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  evaluateSecurityGroups,
  failingStep,
  type ConnectionPeer,
} from '../../src/engine'
import { byId, GREEN_IP, sceneWith, webRequest, workingScene } from './fixtures'

const cloudling: ConnectionPeer = { ip: GREEN_IP, securityGroupIds: [], description: 'a Cloudling' }

describe('allow rules only', () => {
  it('denies all inbound traffic when there are no inbound rules', () => {
    const scene = sceneWith((s) => (byId(s.securityGroups, 'sg-alb').inbound = []))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('security-group')
    expect(failingStep(result)?.at).toEqual({ kind: 'resource', id: 'alb' })
  })

  it('refuses a port that no rule allows (the red kite aiming at SSH 22)', () => {
    const result = evaluateFlow(workingScene(), webRequest({ port: 22, intent: 'hostile' }))
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('security-group')
  })

  it('evaluates all rules together: order does not matter', () => {
    const https = { ports: 'https', peer: { kind: 'anywhere' } } as const
    const ssh = { ports: 'ssh', peer: { kind: 'cidr', cidr: '192.0.2.0/24' } } as const
    for (const inbound of [
      [https, ssh],
      [ssh, https],
    ]) {
      const scene = sceneWith((s) => (byId(s.securityGroups, 'sg-alb').inbound = [...inbound]))
      expect(evaluateSecurityGroups(scene, ['sg-alb'], 'inbound', cloudling, 443).result).toBe(
        'pass',
      )
      expect(evaluateSecurityGroups(scene, ['sg-alb'], 'inbound', cloudling, 22).result).toBe(
        'fail',
      )
    }
  })

  it('combines the rules of every group a resource wears', () => {
    const scene = sceneWith((s) => {
      s.securityGroups.push({
        id: 'sg-extra',
        name: 'extra',
        inbound: [{ ports: 'http', peer: { kind: 'anywhere' } }],
        outbound: [],
      })
    })
    expect(
      evaluateSecurityGroups(scene, ['sg-alb', 'sg-extra'], 'inbound', cloudling, 80).result,
    ).toBe('pass')
    expect(evaluateSecurityGroups(scene, ['sg-alb'], 'inbound', cloudling, 80).result).toBe('fail')
  })
})

describe('rule sources', () => {
  it('matches a CIDR source only for addresses inside it', () => {
    const scene = sceneWith((s) => {
      byId(s.securityGroups, 'sg-alb').inbound = [
        { ports: 'https', peer: { kind: 'cidr', cidr: '203.0.113.0/24' } },
      ]
    })
    expect(evaluateFlow(scene, webRequest()).outcome).toBe('delivered')
    const outside = evaluateFlow(
      scene,
      webRequest({ source: { kind: 'internet', ip: '192.0.2.5' } }),
    )
    expect(failingStep(outside)?.check).toBe('security-group')
  })

  it('treats a security-group source as "any resource wearing that group"', () => {
    const scene = workingScene()
    const wearer: ConnectionPeer = {
      ip: '10.0.1.10',
      securityGroupIds: ['sg-alb'],
      description: 'the load balancer',
    }
    const stranger: ConnectionPeer = {
      ip: '10.0.1.10',
      securityGroupIds: [],
      description: 'something else in the same subnet',
    }
    expect(evaluateSecurityGroups(scene, ['sg-app'], 'inbound', wearer, 80).result).toBe('pass')
    // Same address, but not wearing the group: a group reference is about identity, not location.
    expect(evaluateSecurityGroups(scene, ['sg-app'], 'inbound', stranger, 80).result).toBe('fail')
  })

  it('stops the request at the target when its group does not admit the load balancer', () => {
    const scene = sceneWith((s) => (byId(s.securityGroups, 'sg-app').inbound = []))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('security-group')
    expect(failingStep(result)?.at).toEqual({ kind: 'resource', id: 'app-a' })
  })
})

describe('statefulness', () => {
  it('always allows the reply to an allowed request, even with no outbound rules on the target', () => {
    const scene = sceneWith((s) => (byId(s.securityGroups, 'sg-app').outbound = []))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('delivered')
    expect(result.responseTrace?.[0]?.ruleRef).toBe('stateful: return traffic')
  })

  it("does not need an inbound rule on the load balancer for the target's reply", () => {
    // The load balancer's only inbound rule is HTTPS from the internet; the reply
    // from the target arrives on an ephemeral port and is still let in.
    expect(evaluateFlow(workingScene(), webRequest()).outcome).toBe('delivered')
  })

  it('does apply outbound rules to connections the resource itself starts', () => {
    const scene = sceneWith((s) => (byId(s.securityGroups, 'sg-alb').outbound = []))
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.at).toEqual({ kind: 'resource', id: 'alb' })
    expect(failingStep(result)?.explanation).toMatch('outbound')
  })
})
