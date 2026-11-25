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
  ScenarioEvent,
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
  /** A few words naming what the kite does, e.g. "uploads a photo"; used in the trace inspector. */
  label: string
  /** What the Cloudling says in its speech bubble when clicked, in its own voice. */
  says: string
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
  /**
   * UI elements to draw attention to: 'palette:<id>', 'resource:<id>', 'subnet:<id>' or
   * 'button:fly'. A list points at several at once, e.g. both EC2 instances that wear the
   * security group a step asks about.
   */
  highlight?: string | string[]
  /**
   * Config card sections whose headings pulse while this step is current, to say "over
   * here" (ADR 0008): `<section>:<id>` with a section from `PULSE_SECTIONS`. Used in the
   * beginner levels for every step that asks the player to change a setting.
   */
  pulse?: string[]
  advanceWhen: NarrationTrigger
}

/**
 * The config card sections that can pulse, and what the id after the colon names:
 * a security group, a route table, a load balancer (its listener or its targets), a
 * role (its statements or who wears it), an instance (the role it wears), or an Auto
 * Scaling group (its scaling policy).
 */
export const PULSE_SECTIONS = [
  'security-group',
  'route-table',
  'listener',
  'targets',
  'role-statements',
  'role-wearers',
  'instance-role',
  'group-scaling',
] as const

/**
 * The biggest crowd a level may have: the ground has a place for this many Cloudlings,
 * so every one is drawn (src/game/crowdPlayback.ts).
 */
export const MAX_CROWD = 40
export type PulseSection = (typeof PULSE_SECTIONS)[number]

/** Three tiers, revealed one at a time. Hints carry no penalty. */
export type Hint = {
  objectiveId: string
  nudge: string
  pointer: { text: string; highlight?: string }
  nearAnswer: string
}

/**
 * Scripted events on the level's timeline (src/engine/timeline.ts). So far: crowd
 * surges and crowd waves, which need the level to have a `crowd`. AZ and instance
 * failures will follow.
 */
export type LevelEvent = ScenarioEvent

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
   * A warning shown before the player removes a cloud, by resource id, for clouds whose
   * removal would undo the level's work (Level 1's load balancer and gateway). The player
   * confirms or keeps the cloud. Leave out for no warnings.
   */
  removalWarnings?: Record<string, string>
  /**
   * Gateway endpoint services the player may add routes to. A gateway endpoint is a
   * route-table target, not a cloud, so it is offered on route cards rather than in
   * the palette. Leave out for levels that do not use them.
   */
  gatewayEndpoints?: ('s3' | 'dynamodb')[]
  population: Kite[]
  /**
   * The usual crowd of friendly visitors and how long the run lasts, for levels about
   * capacity and scaling. The crowd is simulated tick by tick (src/engine/crowd.ts),
   * changed by `events`, flown in the sky and reported on the weather station. The
   * named kites in `population` are its regulars: their own journeys are what the trace
   * inspector shows and what the least-privilege star is judged on.
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
