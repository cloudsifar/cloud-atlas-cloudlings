// Placement needs aim (ADR 0007): a cloud dragged from the tray is placed only if it
// is let go over a zone where it belongs; anywhere else it goes back to the tray.
//
// Where each kind belongs follows the AWS rules the bands stand for: an internet-facing
// load balancer and the gateways sit at the edge (public subnets, the VPC border),
// instances in private subnets, S3 outside the VPC.
// https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html
// https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html

import { describe, expect, it } from 'vitest'
import { validSubnetsFor } from '../../src/game/edits'
import { dropZones, layoutScene, SKY, zoneAt, type Point } from '../../src/game/layout'
import { LEVELS } from '../../src/levels'

const scene = () => {
  const level = LEVELS.find((candidate) => candidate.id === 1)
  if (!level) throw new Error('Level 1 is missing')
  return structuredClone(level.initialScene)
}

const zonesFor = (kind: Parameters<typeof dropZones>[1]) => {
  const start = scene()
  return dropZones(layoutScene(start), kind, validSubnetsFor(start, kind))
}

const lowBandMiddle: Point = {
  x: SKY.vpc.x + SKY.vpc.width / 2,
  y: (SKY.low.top + SKY.low.bottom) / 2,
}
const midBandMiddle: Point = {
  x: SKY.vpc.x + SKY.vpc.width / 2,
  y: (SKY.mid.top + SKY.mid.bottom) / 2,
}
const highBandMiddle: Point = { x: SKY.vpc.x + 200, y: (SKY.high.top + SKY.high.bottom) / 2 }

describe('drop zones', () => {
  it('accept a load balancer over the low band', () => {
    expect(zoneAt(zonesFor('load-balancer'), lowBandMiddle)).toBeDefined()
  })

  it("accept an Internet Gateway on the VPC's bottom border", () => {
    const border: Point = { x: lowBandMiddle.x, y: SKY.vpc.y + SKY.vpc.height }
    expect(zoneAt(zonesFor('internet-gateway'), border)).toBeDefined()
  })

  it('refuse a load balancer over the mid band, the high band or the ground', () => {
    const zones = zonesFor('load-balancer')
    expect(zoneAt(zones, midBandMiddle)).toBeUndefined()
    expect(zoneAt(zones, highBandMiddle)).toBeUndefined()
    expect(zoneAt(zones, { x: lowBandMiddle.x, y: SKY.groundY })).toBeUndefined()
  })

  it('refuse an Internet Gateway over the mid band', () => {
    expect(zoneAt(zonesFor('internet-gateway'), midBandMiddle)).toBeUndefined()
  })

  it('give an instance the private subnet it was dropped on', () => {
    const zones = zonesFor('ec2-instance')
    const layout = layoutScene(scene())
    const privateB = layout.subnets['private-b']
    if (!privateB) throw new Error('private-b is missing')
    const point = { x: privateB.x + privateB.width / 2, y: privateB.y + privateB.height / 2 }
    expect(zoneAt(zones, point)?.subnetId).toBe('private-b')
    expect(zoneAt(zones, lowBandMiddle)).toBeUndefined()
  })

  it('accept an Auto Scaling group over the mid band and nowhere else', () => {
    const zones = zonesFor('auto-scaling-group')
    expect(zoneAt(zones, midBandMiddle)).toBeDefined()
    expect(zoneAt(zones, lowBandMiddle)).toBeUndefined()
  })

  it('keep an IAM role to the high band', () => {
    const zones = zonesFor('iam-role')
    expect(zoneAt(zones, highBandMiddle)).toBeDefined()
    expect(zoneAt(zones, lowBandMiddle)).toBeUndefined()
  })
})
