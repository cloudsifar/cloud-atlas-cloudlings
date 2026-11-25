// AWS WAF: a web ACL inspects each web request a load balancer accepts.
//
// AWS behaviour modelled (docs/ENGINE.md, section 16):
// - A web ACL is associated with the load balancer and sees every request it accepts,
//   after its listener has accepted the connection, before a target is chosen.
// - Its rules run in order, and the first that blocks decides; a blocked request gets
//   HTTP 403 Forbidden from WAF and never reaches a target. A request no rule blocks
//   takes the web ACL's default action.
// - An IP set blocks the ranges it lists. A rate-based rule blocks an address while it
//   sends more than its limit in the span it counts over (five minutes by default). The
//   AWS managed Core rule set blocks common exploits carried in the request, such as
//   cross-site scripting and file inclusion.
// - WAF reads the request itself, so it is the only control here that can tell a
//   malicious payload, or a flood, from a visitor: both arrive on an allowed port from
//   an allowed address.
//
// Simplified (docs/SIMPLIFICATIONS.md): the three rule types run in a fixed order; a
// flood's rate is given per Cloudling rather than counted over time, and once it is over
// the limit every request it sends is blocked; any `malicious` payload is one the Core
// rule set recognises.

import { cidrContains } from './address'
import type { WafRule, WafWebAcl } from './model'
import type { CheckOutcome, Flow } from './trace'

/** Requests an ordinary visitor sends in five minutes: a few pages a minute. */
export const ORDINARY_RATE = 20

/** The span a rate-based rule counts over, in minutes (AWS's default evaluation period). */
export const RATE_WINDOW_MINUTES = 5

/** The lowest rate limit AWS WAF accepts per counting span. */
export const LOWEST_RATE_LIMIT = 10

const ORDER: WafRule['kind'][] = ['ip-set', 'rate-based', 'core-rule-set']

const FORBIDDEN = 'WAF answers 403 Forbidden, and no target ever sees it.'

/** A rule's name, as the trace and the cards say it. */
export function describeWafRule(rule: WafRule): string {
  switch (rule.kind) {
    case 'ip-set':
      return `IP set: block ${rule.cidrs.join(', ')}`
    case 'rate-based':
      return `rate-based rule: more than ${rule.limit} requests in ${RATE_WINDOW_MINUTES} minutes from one address`
    case 'core-rule-set':
      return 'AWS managed rules: Core rule set'
  }
}

function blocks(rule: WafRule, flow: Flow, clientIp: string): string | null {
  switch (rule.kind) {
    case 'ip-set': {
      const range = rule.cidrs.find((cidr) => cidrContains(cidr, clientIp))
      return range ? `its IP set lists ${range}, which includes ${clientIp}` : null
    }
    case 'rate-based': {
      const rate = flow.rate ?? ORDINARY_RATE
      return rate > rule.limit
        ? `${clientIp} sent ${rate.toLocaleString('en-GB')} requests in ${RATE_WINDOW_MINUTES} minutes, more than the rate-based rule's limit of ${rule.limit.toLocaleString('en-GB')}`
        : null
    }
    case 'core-rule-set':
      return flow.payload === 'malicious'
        ? 'the AWS managed Core rule set recognised an attack carried in the request (cross-site scripting)'
        : null
  }
}

/** Inspects one request with a web ACL: which rule, if any, blocks it. */
export function evaluateWebAcl(acl: WafWebAcl, flow: Flow, clientIp: string): CheckOutcome {
  const rules = [...acl.rules].sort(
    (first, second) => ORDER.indexOf(first.kind) - ORDER.indexOf(second.kind),
  )
  for (const rule of rules) {
    const reason = blocks(rule, flow, clientIp)
    if (reason)
      return {
        result: 'fail',
        ruleRef: `WAF ${describeWafRule(rule)}`,
        explanation: `Web ACL "${acl.name}" blocks it: ${reason}. ${FORBIDDEN}`,
      }
  }
  if (acl.defaultAction === 'block')
    return {
      result: 'fail',
      ruleRef: 'WAF default action: Block',
      explanation: `Web ACL "${acl.name}" inspects the request; no rule allows it, and its default action is Block. ${FORBIDDEN}`,
    }
  return {
    result: 'pass',
    ruleRef: 'WAF default action: Allow',
    explanation:
      acl.rules.length === 0
        ? `Web ACL "${acl.name}" has no rules yet, so its default action, Allow, lets the request on.`
        : `Web ACL "${acl.name}" inspects the request; no rule blocks it, so its default action, Allow, lets it on.`,
  }
}
