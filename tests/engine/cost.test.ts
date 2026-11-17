// Cost, and the predicates Level 4 (Skyway) is built on.
//
// AWS behaviour these rest on:
// - Gateway endpoints carry no additional charge, and work by adding a
//   prefix-list route to the subnet's route table:
//   https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
// - A NAT gateway is charged per hour it is provisioned and per gigabyte processed:
//   https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-pricing.html
// - The most specific route wins, so a prefix-list route beats 0.0.0.0/0:
//   https://docs.aws.amazon.com/vpc/latest/userguide/route-tables-priority.html
//
// Coins are illustrative relative units, not prices. These tests pin the
// ordering the game teaches, not the numbers.

import { describe, expect, it } from 'vitest'
import {
  coinsFor,
  costOfScene,
  evaluateFlow,
  evaluatePredicate,
  findResource,
} from '../../src/engine'
import { byId, sceneWith, uploadRequest, workingScene } from './fixtures'

const s3ViaEndpoint = {
  destination: 's3',
  target: { kind: 'gateway-endpoint', service: 's3' },
} as const
const privately = { kind: 'service-routed-through-gateway-endpoint', service: 's3' } as const

describe('coins', () => {
  it('charges for a NAT Gateway and nothing for an Internet Gateway or a role', () => {
    const scene = workingScene()
    expect(coinsFor(findResource(scene, 'nat')!)).toBeGreaterThan(0)
    expect(coinsFor(byId(scene.resources, 'igw'))).toBe(0)
    const role = scene.resources.find((resource) => resource.kind === 'iam-role')!
    expect(coinsFor(role)).toBe(0)
  })

  it('makes a NAT Gateway dearer than a small instance', () => {
    const scene = workingScene()
    const instance = scene.resources.find((resource) => resource.kind === 'ec2-instance')!
    expect(coinsFor(findResource(scene, 'nat')!)).toBeGreaterThan(coinsFor(instance))
  })

  it('charges more for a larger instance', () => {
    const scene = workingScene()
    const instance = scene.resources.find((resource) => resource.kind === 'ec2-instance')!
    if (instance.kind !== 'ec2-instance') throw new Error('expected an instance')
    const small = coinsFor({ ...instance, size: 'small' })
    const medium = coinsFor({ ...instance, size: 'medium' })
    const large = coinsFor({ ...instance, size: 'large' })
    expect(medium).toBeGreaterThan(small)
    expect(large).toBeGreaterThan(medium)
  })

  it('totals the scene, and the total is the sum of its lines', () => {
    const cost = costOfScene(workingScene())
    expect(cost.total).toBe(cost.lines.reduce((sum, line) => sum + line.coins, 0))
    expect(cost.lines[0].resourceId).toBe('nat')
  })

  it('adding a gateway endpoint route costs nothing; removing the NAT Gateway saves its coins', () => {
    const before = costOfScene(workingScene()).total
    const withEndpoint = sceneWith((scene) =>
      byId(scene.routeTables, 'rt-private').routes.push(s3ViaEndpoint),
    )
    expect(costOfScene(withEndpoint).total).toBe(before)

    const natCoins = coinsFor(findResource(workingScene(), 'nat')!)
    const withoutNat = sceneWith((scene) => {
      scene.resources = scene.resources.filter((resource) => resource.id !== 'nat')
      byId(scene.routeTables, 'rt-private').routes = [s3ViaEndpoint]
    })
    expect(costOfScene(withoutNat).total).toBe(before - natCoins)
  })
})

describe('cost-at-most', () => {
  it('holds at the scene total and fails one coin below it', () => {
    const scene = workingScene()
    const total = costOfScene(scene).total
    expect(evaluatePredicate(scene, [], { kind: 'cost-at-most', coins: total })).toBe(true)
    expect(evaluatePredicate(scene, [], { kind: 'cost-at-most', coins: total - 1 })).toBe(false)
  })
})

describe('service-routed-through-gateway-endpoint', () => {
  it('is false while S3 traffic leaves through the NAT Gateway', () => {
    expect(evaluatePredicate(workingScene(), [], privately)).toBe(false)
  })

  it('is true once the private route table has the S3 prefix-list route, even with the NAT route still there', () => {
    const scene = sceneWith((draft) =>
      byId(draft.routeTables, 'rt-private').routes.push(s3ViaEndpoint),
    )
    expect(evaluatePredicate(scene, [], privately)).toBe(true)
  })

  it('is false when there is no route to S3 at all', () => {
    const scene = sceneWith((draft) => (byId(draft.routeTables, 'rt-private').routes = []))
    expect(evaluatePredicate(scene, [], privately)).toBe(false)
  })

  it('agrees with the trace: uploads through the endpoint never touch the NAT Gateway', () => {
    const scene = sceneWith((draft) => {
      draft.resources = draft.resources.filter((resource) => resource.id !== 'nat')
      byId(draft.routeTables, 'rt-private').routes = [s3ViaEndpoint]
    })
    const result = evaluateFlow(scene, uploadRequest())
    expect(result.outcome).toBe('delivered')
    expect(result.trace.some((step) => step.at.kind === 'resource' && step.at.id === 'nat')).toBe(
      false,
    )
  })
})
