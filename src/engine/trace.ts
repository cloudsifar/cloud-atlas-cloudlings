// The engine's central contract: every question about a flow is answered with a
// verdict plus a trace. The trace is the single source of truth for playback,
// explanations and hints; nothing downstream re-derives engine logic.

import type { ServiceAction } from './model'

/** Where a flow starts or ends. */
export type FlowEndpoint =
  | { kind: 'internet'; ip: string } // a Cloudling on the ground
  | { kind: 'resource'; id: string }

/** A call the serving instance makes on the request's behalf, e.g. storing an upload in S3. */
export type BackendCall = { destinationId: string; action: ServiceAction }

export type Flow = {
  id: string
  source: FlowEndpoint
  destination: { kind: 'resource'; id: string }
  port: number
  payload: 'clean' | 'malicious'
  /** Who is flying the kite. A hostile flow that gets somewhere it should not is a breach. */
  intent: 'legitimate' | 'hostile'
  /** For flows that call a service directly (e.g. a kite reading a bucket). */
  action?: ServiceAction
  /** Work the application does once the request reaches it. */
  backendCall?: BackendCall
  /**
   * The request's position in the run. The load balancer uses it for round-robin,
   * so the same scene and the same flow always pick the same node and target.
   */
  sequence?: number
}

export type FlowOutcome = 'delivered' | 'blocked' | 'dropped' | 'breach'

/** Which part of the journey a step belongs to. Playback uses it to switch between kite and rain. */
export type Leg = 'request' | 'backend-request' | 'backend-response' | 'response'

export type ResourceRef =
  | { kind: 'ground' }
  | { kind: 'vpc' }
  | { kind: 'subnet'; id: string }
  | { kind: 'resource'; id: string }

export type CheckKind =
  | 'route'
  | 'nacl'
  | 'security-group'
  | 'listener'
  | 'target-selection'
  | 'iam'
  | 'block-public-access'
  | 'bucket-policy'
  | 'delivery'
  /** Enough healthy targets to serve the request in time? Only crowds can fail it (crowd.ts). */
  | 'capacity'

/** The exact rule that decided a check, in a form code can use (scoring reads these). */
export type RuleMatch =
  | {
      kind: 'security-group-rule'
      securityGroupId: string
      direction: 'inbound' | 'outbound'
      index: number
    }
  | { kind: 'nacl-rule'; networkAclId: string; direction: 'inbound' | 'outbound'; number: number }
  | {
      kind: 'role-statement'
      roleId: string
      index: number
      action: ServiceAction
      resourceId: string
    }
  | { kind: 'bucket-statement'; bucketId: string; index: number; action: ServiceAction }

export type TraceStep = {
  leg: Leg
  at: ResourceRef
  check: CheckKind
  result: 'pass' | 'fail'
  /** Which rule matched, for display: e.g. 'NACL rule 100 (deny)'. */
  ruleRef?: string
  /** The same rule, structured. */
  matched?: RuleMatch
  /** Plain English, shown to the player. */
  explanation: string
}

export type FlowResult = {
  outcome: FlowOutcome
  /** Every hop and every check on the way in, in order (including any backend call). */
  trace: TraceStep[]
  /** The return path to the Cloudling. Present only when the request itself got through. */
  responseTrace?: TraceStep[]
}

/** What a single rule module reports; the flow evaluator adds `leg` and `at` to make a TraceStep. */
export type CheckOutcome = Pick<TraceStep, 'result' | 'ruleRef' | 'matched' | 'explanation'>

/** The step that stopped the flow, if any. */
export function failingStep(result: FlowResult): TraceStep | undefined {
  return [...result.trace, ...(result.responseTrace ?? [])].find((step) => step.result === 'fail')
}
