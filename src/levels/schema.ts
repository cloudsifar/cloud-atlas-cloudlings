// The shape of a level file (levels/*.json).
//
// Levels are data, not code. This type is the contract between a level author
// and the game; src/levels/validate.ts checks a JSON file against it.
// docs/LEVEL_AUTHORING.md explains each field with examples.

import type {
  BackendCall,
  Crowd,
  Objective,
  Predicate,
  Resource,
  Scene,
  SecurityGroup,
  ServiceAction,
} from '../engine'

export const REGION_CODES = ['us-east-1', 'eu-central-1', 'sa-east-1', 'ap-northeast-1'] as const
export type RegionCode = (typeof REGION_CODES)[number]

export const REGION_NAMES: Record<RegionCode, string> = {
  'us-east-1': 'N. Virginia',
  'eu-central-1': 'Frankfurt',
  'sa-east-1': 'São Paulo',
  'ap-northeast-1': 'Tokyo',
}

/** One Cloudling and the kite it flies. */
export type Kite = {
  id: string
  kind: 'friendly' | 'hostile'
  /** Where the Cloudling stands on the ground, 0 (left) to 6 (right). */
  groundPosition: number
  /** The Cloudling's address, from the documentation ranges. */
  ip: string
  /** The id of the resource the kite aims at. */
  destinationId: string
  port: number
  payload: 'clean' | 'malicious'
  /** For kites that call a service directly, e.g. reading a bucket. */
  action?: ServiceAction
  /** Work the application does when the request arrives, e.g. storing an upload. */
  backendCall?: BackendCall
  /** A few words shown beside the Cloudling, e.g. "uploads a photo". */
  label: string
}

/** A cloud the player may add. Its id is fixed so kites and objectives can refer to it. */
export type PaletteEntry = {
  /**
   * The resource as it will be added. Placement fills in where it goes:
   * `subnetId` for subnet-bound resources, `subnetIds` for a load balancer.
   */
  resource: Resource
  /** Security groups created along with the resource (a new load balancer brings its own). */
  securityGroups?: SecurityGroup[]
}

/** What moves the narrator on to the next step. */
export type NarrationTrigger =
  /** The player presses "Next". */
  | { kind: 'acknowledged' }
  /** The player opens the config card of this resource, subnet or security group. */
  | { kind: 'card-opened'; subjectId: string }
  /** The scene satisfies a predicate (e.g. a cloud was placed, a rule was added). */
  | { kind: 'scene'; predicate: Predicate }
  /** The kites have flown, whatever happened to them. */
  | { kind: 'run-finished' }
  /** The kites have flown and every objective was met. Use this before a step that congratulates. */
  | { kind: 'level-complete' }

export type NarrationStep = {
  id: string
  text: string
  /** A UI element to draw attention to: 'palette:<id>', 'resource:<id>', 'subnet:<id>' or 'button:fly'. */
  highlight?: string
  advanceWhen: NarrationTrigger
}

/** Three tiers, revealed one at a time. Hints carry no penalty. */
export type Hint = {
  objectiveId: string
  nudge: string
  pointer: { text: string; highlight?: string }
  nearAnswer: string
}

/** Scripted events arrive with Milestone 3; until then the list must be empty. */
export type LevelEvent = never

export type Level = {
  id: number
  slug: string
  title: string
  /** One line: what the level teaches. */
  concept: string
  guidance: 'full' | 'hints' | 'minimal'
  region: RegionCode
  azs: 1 | 2
  /** Narrator steps, in order. May be empty for unguided levels. */
  narration: NarrationStep[]
  /** The scene the player starts from. Every level is self-contained. */
  initialScene: Scene
  /** Ids (resources, security groups, route tables, NACLs) the player may not change. */
  lockedIds: string[]
  palette: PaletteEntry[]
  /**
   * Ids of resources in the initial scene that the player may remove. Clouds the
   * player placed from the palette can always be removed; anything else stays unless
   * it is listed here.
   */
  removableIds?: string[]
  /**
   * Gateway endpoint services the player may add routes to. A gateway endpoint is a
   * route-table target, not a cloud, so it is offered on route cards rather than in
   * the palette. Leave out for levels that do not use them.
   */
  gatewayEndpoints?: ('s3' | 'dynamodb')[]
  population: Kite[]
  /**
   * A crowd of friendly visitors over time, for levels about capacity and scaling.
   * The named kites in `population` still fly one by one; the crowd is simulated
   * tick by tick (src/engine/crowd.ts) and reported on the weather station.
   */
  crowd?: Crowd
  events: LevelEvent[]
  objectives: Objective[]
  stars: {
    /** The third star. The first two are the same for every level. */
    wellArchitected: { text: string; predicates: Predicate[] }
  }
  hints: Hint[]
  /** Ids of fact cards (content/fact-cards.json) shown on the results card. */
  factCards: string[]
  /** The intended finished scene. Hidden from players; used by tests and Demo Mode. */
  referenceSolution: Scene
}
