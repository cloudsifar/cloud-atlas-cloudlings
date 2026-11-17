// Cost: what a scene costs to run, in coins.
//
// Coins are illustrative relative units, not real prices, and the game says so
// wherever it shows them. What they preserve is the *ordering* that matters at
// Cloud Practitioner level:
//
// - A NAT Gateway is charged for every hour it exists (plus data processed), so
//   it is one of the dearer things in a small architecture.
// - A gateway endpoint (S3, DynamoDB) has no charge. It is a route, not a
//   resource, so it does not appear in this table at all.
// - An Internet Gateway and an IAM role have no charge.
// - A larger instance costs more whether or not the extra capacity is used.

import type { Resource, Scene } from './model'

const INSTANCE_COINS = { small: 2, medium: 4, large: 8 } as const

/** The running cost of one resource, in coins. */
export function coinsFor(resource: Resource): number {
  switch (resource.kind) {
    case 'nat-gateway':
      return 8
    case 'load-balancer':
      return 4
    case 'ec2-instance':
      return INSTANCE_COINS[resource.size]
    case 's3-bucket':
      return 1
    case 'internet-gateway':
    case 'iam-role':
      return 0
  }
}

export type CostLine = { resourceId: string; name: string; coins: number }

export type SceneCost = {
  total: number
  /** One line per resource that costs something, dearest first. */
  lines: CostLine[]
}

export function costOfScene(scene: Scene): SceneCost {
  const lines = scene.resources
    .map((resource) => ({
      resourceId: resource.id,
      name: resource.name,
      coins: coinsFor(resource),
    }))
    .filter((line) => line.coins > 0)
    .sort((first, second) => second.coins - first.coins)
  return { total: lines.reduce((sum, line) => sum + line.coins, 0), lines }
}
