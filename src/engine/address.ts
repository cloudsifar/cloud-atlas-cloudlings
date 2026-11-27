// IPv4 addresses and CIDR matching: just enough to decide "does this rule's
// range contain this address?". Subnet arithmetic beyond that is out of scope.

import type { CidrPeer, Subnet } from './model'

/**
 * An illustrative public address standing in for "the Amazon S3 endpoint".
 * Real S3 uses many published ranges; rules in the game can only name
 * 'anywhere' or a listed CIDR, so one stand-in outside every listed range is enough.
 */
export const S3_ENDPOINT_ADDRESS = '52.216.0.10'

/**
 * A stand-in public address for the Systems Manager endpoints (ssm, ssmmessages and
 * ec2messages) that the SSM Agent connects out to, outside every listed range.
 */
export const SSM_ENDPOINT_ADDRESS = '52.94.0.20'

function toNumber(ip: string): number {
  const parts = ip.split('.').map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new Error(`"${ip}" is not an IPv4 address`)
  }
  return parts.reduce((total, part) => total * 256 + part, 0)
}

export function cidrContains(cidr: string, ip: string): boolean {
  const [base, lengthText] = cidr.split('/')
  const length = Number(lengthText)
  if (base === undefined || !Number.isInteger(length) || length < 0 || length > 32) {
    throw new Error(`"${cidr}" is not a CIDR block`)
  }
  const blockSize = 2 ** (32 - length)
  return Math.floor(toNumber(ip) / blockSize) === Math.floor(toNumber(base) / blockSize)
}

export function cidrPeerContains(peer: CidrPeer, ip: string): boolean {
  return peer.kind === 'anywhere' || cidrContains(peer.cidr, ip)
}

export function describeCidrPeer(peer: CidrPeer): string {
  return peer.kind === 'anywhere' ? 'anywhere (0.0.0.0/0)' : peer.cidr
}

/**
 * A representative private address for anything living in a subnet (host .10).
 * Rules match on ranges, so which host inside the subnet does not matter.
 */
export function addressInSubnet(subnet: Subnet): string {
  const [base] = subnet.cidr.split('/')
  const parts = (base ?? '').split('.')
  return `${parts[0]}.${parts[1]}.${parts[2]}.10`
}
