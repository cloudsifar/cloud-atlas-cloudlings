// Named ports. The player never types a port number; they pick one of these.

import type { PortOption } from './model'

export type PortRange = { label: string; from: number; to: number }

export const PORT_OPTIONS: Record<PortOption, PortRange> = {
  http: { label: 'HTTP 80', from: 80, to: 80 },
  https: { label: 'HTTPS 443', from: 443, to: 443 },
  ssh: { label: 'SSH 22', from: 22, to: 22 },
  mysql: { label: 'MySQL 3306', from: 3306, to: 3306 },
  postgresql: { label: 'PostgreSQL 5432', from: 5432, to: 5432 },
  nfs: { label: 'NFS 2049', from: 2049, to: 2049 },
  ephemeral: { label: 'Ephemeral 1024–65535', from: 1024, to: 65535 },
  all: { label: 'All traffic', from: 0, to: 65535 },
}

export const HTTP_PORT = 80
export const HTTPS_PORT = 443

/**
 * The port a client listens on for the reply to a request it started.
 * Real clients pick any port in the ephemeral range; one fixed representative
 * keeps the engine deterministic. Any rule covering 1024–65535 matches it.
 */
export const REPRESENTATIVE_EPHEMERAL_PORT = 49152

export function portOptionCovers(option: PortOption, port: number): boolean {
  const range = PORT_OPTIONS[option]
  return port >= range.from && port <= range.to
}

export function describePort(port: number): string {
  if (port === REPRESENTATIVE_EPHEMERAL_PORT) return 'an ephemeral port (1024–65535)'
  const named = Object.values(PORT_OPTIONS).find((range) => range.from === port && range.to === port)
  return named ? named.label : `port ${port}`
}
