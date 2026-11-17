// A complete, working three-tier scene used as the starting point for engine tests.
// Each test copies it and changes the one thing under test.

import type { Flow, Scene } from '../../src/engine'

export const GREEN_IP = '203.0.113.10'
export const BAD_RANGE_IP = '198.51.100.7'

const allowAllRule = {
  number: 100,
  action: 'allow',
  peer: { kind: 'anywhere' },
  ports: 'all',
} as const

export function workingScene(): Scene {
  return {
    vpc: { cidr: '10.0.0.0/16' },
    subnets: [
      {
        id: 'public-a',
        name: 'Public subnet A',
        availabilityZone: 'a',
        band: 'low',
        cidr: '10.0.1.0/24',
        routeTableId: 'rt-public',
        networkAclId: 'nacl-default',
      },
      {
        id: 'public-b',
        name: 'Public subnet B',
        availabilityZone: 'b',
        band: 'low',
        cidr: '10.0.2.0/24',
        routeTableId: 'rt-public',
        networkAclId: 'nacl-default',
      },
      {
        id: 'private-a',
        name: 'Private subnet A',
        availabilityZone: 'a',
        band: 'mid',
        cidr: '10.0.11.0/24',
        routeTableId: 'rt-private',
        networkAclId: 'nacl-default',
      },
      {
        id: 'private-b',
        name: 'Private subnet B',
        availabilityZone: 'b',
        band: 'mid',
        cidr: '10.0.12.0/24',
        routeTableId: 'rt-private',
        networkAclId: 'nacl-default',
      },
    ],
    routeTables: [
      {
        id: 'rt-public',
        name: 'Public route table',
        routes: [{ destination: 'internet', target: { kind: 'internet-gateway' } }],
      },
      {
        id: 'rt-private',
        name: 'Private route table',
        routes: [{ destination: 'internet', target: { kind: 'nat-gateway', natGatewayId: 'nat' } }],
      },
    ],
    networkAcls: [
      {
        id: 'nacl-default',
        name: 'Default NACL',
        inbound: [{ ...allowAllRule }],
        outbound: [{ ...allowAllRule }],
      },
    ],
    securityGroups: [
      {
        id: 'sg-alb',
        name: 'alb-sg',
        inbound: [{ ports: 'https', peer: { kind: 'anywhere' } }],
        outbound: [{ ports: 'all', peer: { kind: 'anywhere' } }],
      },
      {
        id: 'sg-app',
        name: 'app-sg',
        inbound: [{ ports: 'http', peer: { kind: 'security-group', securityGroupId: 'sg-alb' } }],
        outbound: [{ ports: 'all', peer: { kind: 'anywhere' } }],
      },
    ],
    resources: [
      { kind: 'internet-gateway', id: 'igw', name: 'Internet Gateway' },
      { kind: 'nat-gateway', id: 'nat', name: 'NAT Gateway', subnetId: 'public-a' },
      {
        kind: 'load-balancer',
        id: 'alb',
        name: 'Application Load Balancer',
        scheme: 'internet-facing',
        subnetIds: ['public-a', 'public-b'],
        securityGroupIds: ['sg-alb'],
        listener: 'https',
        targetIds: ['app-a', 'app-b'],
      },
      {
        kind: 'ec2-instance',
        id: 'app-a',
        name: 'EC2 instance A',
        subnetId: 'private-a',
        securityGroupIds: ['sg-app'],
        roleId: 'app-role',
        size: 'small',
        healthy: true,
      },
      {
        kind: 'ec2-instance',
        id: 'app-b',
        name: 'EC2 instance B',
        subnetId: 'private-b',
        securityGroupIds: ['sg-app'],
        roleId: 'app-role',
        size: 'small',
        healthy: true,
      },
      {
        kind: 's3-bucket',
        id: 'photos',
        name: 'photo-bucket',
        blockPublicAccess: true,
        policy: [],
        dataClass: 'sensitive',
        encryption: { kind: 'sse-s3' },
      },
      {
        kind: 'iam-role',
        id: 'app-role',
        name: 'app-role',
        statements: [{ effect: 'allow', actions: ['s3:Write'], resource: 'photos' }],
      },
    ],
  }
}

/** Copies the working scene and applies one change to the copy. */
export function sceneWith(change: (scene: Scene) => void): Scene {
  const scene = workingScene()
  change(scene)
  return scene
}

/** A friendly kite to the load balancer on HTTPS. */
export function webRequest(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'green-1',
    source: { kind: 'internet', ip: GREEN_IP },
    destination: { kind: 'resource', id: 'alb' },
    port: 443,
    payload: 'clean',
    intent: 'legitimate',
    sequence: 0,
    ...overrides,
  }
}

/** A friendly kite whose request makes the instance store an upload in the bucket. */
export function uploadRequest(overrides: Partial<Flow> = {}): Flow {
  return webRequest({ backendCall: { destinationId: 'photos', action: 's3:Write' }, ...overrides })
}

/** An attacker on the ground trying to read the bucket directly. */
export function anonymousBucketRead(overrides: Partial<Flow> = {}): Flow {
  return {
    id: 'red-1',
    source: { kind: 'internet', ip: BAD_RANGE_IP },
    destination: { kind: 'resource', id: 'photos' },
    port: 443,
    payload: 'clean',
    intent: 'hostile',
    action: 's3:Read',
    ...overrides,
  }
}

export function byId<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find((candidate) => candidate.id === id)
  if (!item) throw new Error(`fixture has no "${id}"`)
  return item
}
