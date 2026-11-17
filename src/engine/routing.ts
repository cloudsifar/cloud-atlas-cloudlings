// Routing: where a subnet's route table sends traffic.

import {
  requireRouteTable,
  resourcesOfKind,
  type NatGateway,
  type RouteDestination,
  type Scene,
  type Subnet,
} from './model'

/** What a packet leaving a subnet is trying to reach. */
export type RouteQuery = 'vpc' | RouteDestination

export type RouteDecision =
  | { kind: 'local' }
  | { kind: 'internet-gateway' }
  | { kind: 'nat-gateway'; natGateway: NatGateway }
  | { kind: 'gateway-endpoint'; service: 's3' | 'dynamodb' }
  /** The table names a target that no longer exists. */
  | { kind: 'blackhole'; reason: string }
  | { kind: 'no-route' }

/**
 * How specific each kind of route is. A higher number is a longer prefix:
 * the VPC's own range and a service prefix list are both narrower than 0.0.0.0/0.
 */
const SPECIFICITY: Record<RouteQuery, number> = { internet: 0, s3: 1, dynamodb: 1, vpc: 2 }

/** Does a route for `destination` cover traffic heading for `query`? */
function routeCovers(destination: RouteDestination, query: RouteQuery): boolean {
  if (query === 'vpc') return false // only the implicit local route covers the VPC
  // 0.0.0.0/0 covers every address outside the VPC, including the AWS service endpoints.
  return destination === 'internet' || destination === query
}

/**
 * AWS behaviour modelled: every route table has an implicit local route for the
 * VPC that cannot be removed. Among the routes that match a destination, the
 * most specific one wins, so a prefix-list route (gateway endpoint) beats
 * 0.0.0.0/0, and the local route beats everything for addresses inside the VPC.
 */
export function resolveRoute(scene: Scene, subnet: Subnet, query: RouteQuery): RouteDecision {
  if (query === 'vpc') return { kind: 'local' }

  const table = requireRouteTable(scene, subnet.routeTableId)
  const matching = table.routes
    .filter((route) => routeCovers(route.destination, query))
    .sort((first, second) => SPECIFICITY[second.destination] - SPECIFICITY[first.destination])
  const best = matching[0]
  if (!best) return { kind: 'no-route' }

  switch (best.target.kind) {
    case 'internet-gateway':
      return resourcesOfKind(scene, 'internet-gateway').length > 0
        ? { kind: 'internet-gateway' }
        : {
            kind: 'blackhole',
            reason: 'the route points at an Internet Gateway that is not attached',
          }
    case 'nat-gateway': {
      const natGatewayId = best.target.natGatewayId
      const natGateway = resourcesOfKind(scene, 'nat-gateway').find(
        (nat) => nat.id === natGatewayId,
      )
      return natGateway
        ? { kind: 'nat-gateway', natGateway }
        : { kind: 'blackhole', reason: 'the route points at a NAT Gateway that no longer exists' }
    }
    case 'gateway-endpoint':
      return { kind: 'gateway-endpoint', service: best.target.service }
  }
}

/**
 * AWS behaviour modelled: a subnet is public if and only if its route table
 * sends 0.0.0.0/0 to an Internet Gateway attached to the VPC. Nothing else
 * (its name, its position, what it contains) makes a subnet public.
 */
export function isPublicSubnet(scene: Scene, subnet: Subnet): boolean {
  return resolveRoute(scene, subnet, 'internet').kind === 'internet-gateway'
}
