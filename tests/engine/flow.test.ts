// The flow evaluator as a whole: path order, purity and determinism.
//
// AWS documentation these tests are based on:
// - How traffic passes NACLs and security groups on its way to an instance:
//   https://docs.aws.amazon.com/vpc/latest/userguide/infrastructure-security.html
// - Request routing through an Application Load Balancer:
//   https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html

import { describe, expect, it } from 'vitest'
import { evaluateFlow, type TraceStep } from '../../src/engine'
import { uploadRequest, webRequest, workingScene } from './fixtures'

const where = (step: TraceStep) => ('id' in step.at ? step.at.id : step.at.kind)
const summary = (steps: TraceStep[]) =>
  steps.map((step) => `${step.leg} ${step.check} @ ${where(step)}`)

describe('request path order', () => {
  it('walks a web request through every check in AWS order, and the response back', () => {
    const result = evaluateFlow(workingScene(), webRequest({ sequence: 0 }))
    expect(summary(result.trace)).toEqual([
      'request route @ vpc', // in through the Internet Gateway
      'request nacl @ public-a', // inbound NACL of the load balancer's subnet
      'request security-group @ alb', // load balancer security group
      'request listener @ alb',
      'request target-selection @ alb',
      'request security-group @ alb', // outbound, towards the target
      'request nacl @ public-a', // outbound NACL of the load balancer's subnet
      'request nacl @ private-a', // inbound NACL of the target's subnet
      'request security-group @ app-a', // target security group
      'request delivery @ app-a',
    ])
    expect(summary(result.responseTrace ?? [])).toEqual([
      'response security-group @ app-a', // stateful: noted, not evaluated
      'response nacl @ private-a', // NACLs are evaluated again on the way back
      'response nacl @ public-a',
      'response nacl @ public-a',
      'response delivery @ ground',
    ])
  })

  it('puts the backend call between the request and the response', () => {
    const result = evaluateFlow(workingScene(), uploadRequest({ sequence: 0 }))
    const backend = result.trace.filter((step) => step.leg.startsWith('backend'))
    expect(summary(backend)).toEqual([
      'backend-request security-group @ app-a', // outbound from the instance
      'backend-request nacl @ private-a',
      'backend-request route @ private-a', // 0.0.0.0/0 -> NAT Gateway
      'backend-request nacl @ public-a', // into the NAT Gateway's subnet
      'backend-request nacl @ public-a', // and out of it
      'backend-request route @ nat',
      'backend-request iam @ photos',
      'backend-response nacl @ public-a',
      'backend-response nacl @ public-a',
      'backend-response nacl @ private-a',
    ])
    expect(result.outcome).toBe('delivered')
  })
})

describe('purity', () => {
  it('gives the same result for the same scene and flow', () => {
    const scene = workingScene()
    expect(evaluateFlow(scene, uploadRequest())).toEqual(evaluateFlow(scene, uploadRequest()))
  })

  it('never changes the scene it is given', () => {
    const scene = workingScene()
    const before = JSON.stringify(scene)
    evaluateFlow(scene, uploadRequest())
    expect(JSON.stringify(scene)).toBe(before)
  })
})

describe('edges', () => {
  it('blocks, rather than throws, when the destination has not been built', () => {
    const result = evaluateFlow(
      workingScene(),
      webRequest({ destination: { kind: 'resource', id: 'nothing' } }),
    )
    expect(result.outcome).toBe('blocked')
  })

  it('throws for pairings the game does not model, so a bad level fails loudly', () => {
    expect(() =>
      evaluateFlow(workingScene(), webRequest({ source: { kind: 'resource', id: 'photos' } })),
    ).toThrow('does not model')
  })

  it('gives every step an explanation', () => {
    const result = evaluateFlow(workingScene(), uploadRequest())
    for (const step of [...result.trace, ...(result.responseTrace ?? [])]) {
      expect(step.explanation.length).toBeGreaterThan(20)
    }
  })
})
