// Player-facing names for the engine's check kinds. Kept in one place so the
// sky, the trace inspector and the hints all use the same words.

import type { CheckKind, FlowOutcome } from '../engine'

export const CHECK_LABELS: Record<CheckKind, string> = {
  route: 'Route',
  nacl: 'Network ACL',
  'security-group': 'Security group',
  listener: 'Listener',
  waf: 'AWS WAF',
  'target-selection': 'Target choice',
  iam: 'IAM',
  'block-public-access': 'Block Public Access',
  'bucket-policy': 'Bucket policy',
  delivery: 'Delivery',
  capacity: 'Capacity',
}

export const OUTCOME_LABELS: Record<FlowOutcome, string> = {
  delivered: 'Delivered',
  blocked: 'Blocked',
  dropped: 'Timed out',
  breach: 'Breach',
}
