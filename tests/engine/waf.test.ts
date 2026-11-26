// AWS WAF web ACLs on a load balancer, the edge network ACL of Level 7, and how both
// are scored.
//
// AWS documentation these tests are based on:
// - Web ACLs and their default action (a request no rule terminates takes it):
//   https://docs.aws.amazon.com/waf/latest/developerguide/web-acl-default-action.html
// - Rate-based rules: a limit per evaluation window (five minutes by default; 1, 2 or 10
//   are possible), limits from 10, the action applied to further requests over it:
//   https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based-high-level-settings.html
//   https://aws.amazon.com/about-aws/whats-new/2024/08/aws-waf-rate-based-rules-lower-rate-limits
// - The Core rule set (AWSManagedRulesCommonRuleSet): cross-site scripting, file
//   inclusion and other common exploits; SQL injection is in a separate rule group:
//   https://docs.aws.amazon.com/waf/latest/developerguide/aws-managed-rule-groups-baseline.html
// - A blocked request gets HTTP 403 (Forbidden):
//   https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-action.html
// - Network ACL rule numbers run from 1 to 32766; leave room between them
//   (100, 110, 120), so a rule can be added between existing ones without renumbering:
//   https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateNetworkAclEntry.html
// - Give a deny rule a lower number than the allow it carves an exception from:
//   https://docs.aws.amazon.com/vpc/latest/userguide/nacl-rules.html

import { describe, expect, it } from 'vitest'
import {
  evaluateFlow,
  evaluatePredicate,
  evaluateWebAcl,
  failingStep,
  ORDINARY_RATE,
  scoreScene,
  validateScene,
  type FlowRun,
  type NetworkAcl,
  type Scene,
  type WafRule,
  type WafWebAcl,
} from '../../src/engine'
import { BAD_RANGE_IP, byId, GREEN_IP, sceneWith, webRequest, workingScene } from './fixtures'

const webAcl = (rules: WafRule[], overrides: Partial<WafWebAcl> = {}): WafWebAcl => ({
  kind: 'waf-web-acl',
  id: 'shop-waf',
  name: 'shop-web-acl',
  loadBalancerId: 'alb',
  defaultAction: 'allow',
  rules,
  ...overrides,
})

const withWebAcl = (rules: WafRule[], overrides: Partial<WafWebAcl> = {}): Scene =>
  sceneWith((s) => s.resources.push(webAcl(rules, overrides)))

const CORE: WafRule = { kind: 'core-rule-set' }
const RATE: WafRule = { kind: 'rate-based', limit: 100 }

const script = webRequest({ id: 'red-script', intent: 'hostile', payload: 'malicious' })
const flood = webRequest({ id: 'red-flood', intent: 'hostile', rate: 3000 })

describe('what a web ACL blocks', () => {
  it('lets an ordinary visitor through on its default action, Allow', () => {
    const outcome = evaluateWebAcl(webAcl([CORE, RATE]), webRequest(), GREEN_IP)
    expect(outcome.result).toBe('pass')
    expect(outcome.ruleRef).toBe('WAF default action: Allow')
  })

  it('blocks a malicious payload with the Core rule set, answering 403 Forbidden', () => {
    const outcome = evaluateWebAcl(webAcl([CORE]), script, GREEN_IP)
    expect(outcome.result).toBe('fail')
    expect(outcome.ruleRef).toBe('WAF AWS managed rules: Core rule set')
    expect(outcome.explanation).toContain('403 Forbidden')
  })

  it('lets a malicious payload through without the Core rule set: the rate is ordinary', () => {
    expect(evaluateWebAcl(webAcl([RATE]), script, GREEN_IP).result).toBe('pass')
  })

  it('blocks an address sending more than the rate-based limit, and only those', () => {
    expect(evaluateWebAcl(webAcl([RATE]), flood, GREEN_IP).result).toBe('fail')
    expect(evaluateWebAcl(webAcl([RATE]), flood, GREEN_IP).ruleRef).toContain('rate-based')
    // At the limit is not over it; an ordinary visitor is far below it.
    expect(evaluateWebAcl(webAcl([RATE]), webRequest({ rate: 100 }), GREEN_IP).result).toBe('pass')
    expect(ORDINARY_RATE).toBeLessThan(100)
    // The Core rule set does not count requests: a clean flood passes it.
    expect(evaluateWebAcl(webAcl([CORE]), flood, GREEN_IP).result).toBe('pass')
  })

  it('blocks the ranges an IP set lists', () => {
    const ipSet: WafRule = { kind: 'ip-set', cidrs: ['198.51.100.0/24'] }
    expect(evaluateWebAcl(webAcl([ipSet]), webRequest(), BAD_RANGE_IP).result).toBe('fail')
    expect(evaluateWebAcl(webAcl([ipSet]), webRequest(), GREEN_IP).result).toBe('pass')
  })

  it('runs its rules in a fixed order: IP set, rate-based, Core rule set', () => {
    const both = webRequest({ intent: 'hostile', payload: 'malicious', rate: 3000 })
    expect(evaluateWebAcl(webAcl([CORE, RATE]), both, GREEN_IP).ruleRef).toContain('rate-based')
  })

  it('blocks what no rule allows when its default action is Block', () => {
    const outcome = evaluateWebAcl(webAcl([], { defaultAction: 'block' }), webRequest(), GREEN_IP)
    expect(outcome.result).toBe('fail')
    expect(outcome.ruleRef).toBe('WAF default action: Block')
  })
})

describe('the web ACL on the request path', () => {
  it('inspects the request after the listener accepts it and before a target is chosen', () => {
    const trace = evaluateFlow(withWebAcl([CORE, RATE]), webRequest()).trace
    const checks = trace.filter((step) => step.leg === 'request').map((step) => step.check)
    const at = (check: string) => checks.indexOf(check as (typeof checks)[number])
    expect(at('listener')).toBeLessThan(at('waf'))
    expect(at('waf')).toBeLessThan(at('target-selection'))
  })

  it('stops a blocked kite at WAF: no target ever sees it', () => {
    const result = evaluateFlow(withWebAcl([CORE]), script)
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.check).toBe('waf')
    expect(result.trace.some((step) => step.check === 'target-selection')).toBe(false)
  })

  it('never sees a request the listener refused', () => {
    // The load balancer's security group lets SSH in, so the listener is what refuses it.
    const scene = withWebAcl([CORE])
    byId(scene.securityGroups, 'sg-alb').inbound.push({ ports: 'ssh', peer: { kind: 'anywhere' } })
    const result = evaluateFlow(scene, webRequest({ port: 22 }))
    expect(failingStep(result)?.check).toBe('listener')
    expect(result.trace.some((step) => step.check === 'waf')).toBe(false)
  })

  it('adds no step when no web ACL protects the load balancer', () => {
    expect(
      evaluateFlow(workingScene(), webRequest()).trace.some((step) => step.check === 'waf'),
    ).toBe(false)
  })
})

describe('a hostile kite that reaches the application', () => {
  it('is a breach, whatever it carries: the attack got where it was going', () => {
    expect(evaluateFlow(workingScene(), flood).outcome).toBe('breach')
    expect(evaluateFlow(workingScene(), script).outcome).toBe('breach')
    const stuffing = webRequest({
      intent: 'hostile',
      source: { kind: 'internet', ip: BAD_RANGE_IP },
    })
    expect(evaluateFlow(workingScene(), stuffing).outcome).toBe('breach')
  })

  it('says a flood reached it, in the trace', () => {
    const delivery = evaluateFlow(workingScene(), flood).trace.find(
      (step) => step.check === 'delivery',
    )
    expect(delivery?.explanation).toContain('A flood of 3,000 requests')
  })
})

describe('validating web ACLs and network ACL numbers', () => {
  const problems = (scene: Scene) => validateScene(scene).map((problem) => problem.message)

  it('accepts a web ACL on the load balancer', () => {
    expect(problems(withWebAcl([CORE, RATE]))).toEqual([])
  })

  it('refuses a second web ACL on the same load balancer', () => {
    const scene = withWebAcl([CORE])
    scene.resources.push(webAcl([RATE], { id: 'second', name: 'second-acl' }))
    expect(problems(scene).some((message) => message.includes('only one web ACL'))).toBe(true)
  })

  it('refuses a rate limit below 10 and a load balancer that does not exist', () => {
    expect(problems(withWebAcl([{ kind: 'rate-based', limit: 5 }])).length).toBeGreaterThan(0)
    expect(problems(withWebAcl([CORE], { loadBalancerId: 'nowhere' })).length).toBeGreaterThan(0)
  })

  it('refuses a network ACL rule numbered outside 1 to 32766', () => {
    const scene = sceneWith((s) => {
      byId(s.networkAcls, 'nacl-default').inbound.push({
        number: 40000,
        action: 'deny',
        ports: 'all',
        peer: { kind: 'anywhere' },
      })
    })
    expect(problems(scene).some((message) => message.includes('1 to 32766'))).toBe(true)
  })
})

// Level 7's edge: a custom network ACL on both public subnets, as the reference does it.
const EDGE: NetworkAcl = {
  id: 'edge',
  name: 'edge-acl',
  inbound: [
    { number: 90, action: 'deny', ports: 'all', peer: { kind: 'cidr', cidr: '198.51.100.0/24' } },
    { number: 100, action: 'allow', ports: 'https', peer: { kind: 'anywhere' } },
    {
      number: 200,
      action: 'allow',
      ports: 'ephemeral',
      peer: { kind: 'cidr', cidr: '10.0.0.0/16' },
    },
  ],
  outbound: [
    { number: 100, action: 'allow', ports: 'ephemeral', peer: { kind: 'anywhere' } },
    { number: 200, action: 'allow', ports: 'http', peer: { kind: 'cidr', cidr: '10.0.0.0/16' } },
  ],
}
const withEdge = (change: (acl: NetworkAcl) => void = () => {}): Scene =>
  sceneWith((s) => {
    const acl = structuredClone(EDGE)
    change(acl)
    s.networkAcls.push(acl)
    byId(s.subnets, 'public-a').networkAclId = 'edge'
    byId(s.subnets, 'public-b').networkAclId = 'edge'
  })
// Visitors browsing the shop. They make no uploads, so the scoring below leaves the
// fixture's app role out: it is not what these tests are about.
const visitors = (scene: Scene): FlowRun[] =>
  [0, 1, 2, 3].map((sequence) => {
    const flow = webRequest({ id: `g${sequence}`, sequence })
    return { flow, result: evaluateFlow(scene, flow) }
  })

describe('the edge network ACL', () => {
  it('lets visitors in and out, and denies the bad range at the edge', () => {
    const scene = withEdge()
    expect(visitors(scene).every((run) => run.result.outcome === 'delivered')).toBe(true)
    const bad = evaluateFlow(scene, webRequest({ source: { kind: 'internet', ip: BAD_RANGE_IP } }))
    expect(failingStep(bad)?.check).toBe('nacl')
    expect(failingStep(bad)?.ruleRef).toBe('NACL rule 90 (deny)')
  })

  it('never reads a deny numbered after the allow: the first match decides', () => {
    const scene = withEdge((acl) => (acl.inbound[0]!.number = 110))
    const bad = evaluateFlow(scene, webRequest({ source: { kind: 'internet', ip: BAD_RANGE_IP } }))
    expect(bad.outcome).toBe('delivered')
  })

  it('drops every reply without the outbound ephemeral rule: network ACLs are stateless', () => {
    const scene = withEdge(
      (acl) => (acl.outbound = acl.outbound.filter((rule) => rule.number !== 100)),
    )
    const result = evaluateFlow(scene, webRequest())
    expect(result.outcome).toBe('blocked')
    expect(failingStep(result)?.leg).toBe('response')
    expect(failingStep(result)?.check).toBe('nacl')
  })
})

describe('scoring and predicates for the edge', () => {
  const findingsFor = (scene: Scene) => scoreScene(scene, visitors(scene), ['app-role'])

  it('finds nothing to trim in a tight edge ACL, and never counts deny rules', () => {
    expect(findingsFor(withEdge())).toEqual([])
  })

  it('flags an allow rule no visitor needs, and one that opens all traffic', () => {
    const extra = withEdge((acl) =>
      acl.inbound.push({ number: 300, action: 'allow', ports: 'ssh', peer: { kind: 'anywhere' } }),
    )
    expect(findingsFor(extra).map((finding) => finding.subjectId)).toEqual(['edge'])
    const wide = withEdge((acl) => (acl.outbound[0]!.ports = 'all'))
    expect(findingsFor(wide)[0]?.message).toContain('allows all traffic out')
  })

  it('leaves the default network ACL alone: it is AWS’s starting point', () => {
    expect(findingsFor(workingScene())).toEqual([])
  })

  it('knows which subnets use the ACL, and whether it allows a rule', () => {
    const scene = withEdge()
    const holds = (predicate: Parameters<typeof evaluatePredicate>[2]) =>
      evaluatePredicate(scene, [], predicate)
    expect(
      holds({
        kind: 'network-acl-on-subnets',
        networkAclId: 'edge',
        subnetIds: ['public-a', 'public-b'],
      }),
    ).toBe(true)
    expect(
      holds({ kind: 'network-acl-on-subnets', networkAclId: 'edge', subnetIds: ['private-a'] }),
    ).toBe(false)
    expect(
      holds({
        kind: 'network-acl-allows',
        networkAclId: 'edge',
        direction: 'outbound',
        ports: 'ephemeral',
        peer: { kind: 'anywhere' },
      }),
    ).toBe(true)
  })

  it('knows when rule numbers leave room to insert a rule, as AWS recommends', () => {
    const spaced = (change: (acl: NetworkAcl) => void) =>
      evaluatePredicate(withEdge(change), [], {
        kind: 'network-acl-rules-spaced',
        networkAclId: 'edge',
        gap: 10,
      })
    expect(spaced(() => {})).toBe(true)
    expect(spaced((acl) => (acl.inbound[0]!.number = 99))).toBe(false) // 99 then 100
    expect(spaced((acl) => (acl.inbound[0]!.number = 5))).toBe(false) // no room before it
  })

  it('knows when a web ACL with the rules asked for protects the load balancer', () => {
    const holds = (scene: Scene) =>
      evaluatePredicate(scene, [], {
        kind: 'web-acl-protects',
        loadBalancerId: 'alb',
        rules: ['core-rule-set', 'rate-based'],
      })
    expect(holds(withWebAcl([CORE, RATE]))).toBe(true)
    expect(holds(withWebAcl([CORE]))).toBe(false)
    expect(holds(withWebAcl([CORE, RATE], { loadBalancerId: null }))).toBe(false)
  })
})
