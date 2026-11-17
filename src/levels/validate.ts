// validateLevel: checks an unknown value (parsed JSON) against the Level type,
// then checks the cross-references a type cannot express.
//
// Returns a list of human-readable errors; an empty list means the level is valid.
// Every message starts with the JSON path of the problem.

import { cidrContains, validateScene, type ResourceKind, type Scene } from '../engine'
import { REGION_CODES, type Level } from './schema'

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The fields every resource of a kind must have, with the `typeof` each must be. */
const RESOURCE_FIELDS: Record<ResourceKind, Record<string, 'string' | 'boolean' | 'object'>> = {
  'internet-gateway': {},
  'nat-gateway': { subnetId: 'string' },
  'load-balancer': {
    scheme: 'string',
    subnetIds: 'object',
    securityGroupIds: 'object',
    listener: 'string',
    targetIds: 'object',
  },
  'auto-scaling-group': {
    subnetIds: 'object',
    securityGroupIds: 'object',
    size: 'string',
    scaling: 'object',
  },
  'ec2-instance': {
    subnetId: 'string',
    securityGroupIds: 'object',
    size: 'string',
    healthy: 'boolean',
  },
  's3-bucket': {
    blockPublicAccess: 'boolean',
    policy: 'object',
    dataClass: 'string',
    encryption: 'object',
  },
  'iam-role': { statements: 'object' },
}

/** Cloudlings must use the address ranges reserved for documentation (RFC 5737). */
const DOCUMENTATION_RANGES = ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24']

function checkSceneShape(value: unknown, path: string, errors: string[]): value is Scene {
  if (!isObject(value)) {
    errors.push(`${path}: expected a scene object`)
    return false
  }
  const before = errors.length
  if (!isObject(value.vpc) || typeof value.vpc.cidr !== 'string')
    errors.push(`${path}.vpc: expected { cidr }`)
  for (const list of ['subnets', 'routeTables', 'networkAcls', 'securityGroups', 'resources']) {
    const items = value[list]
    if (!Array.isArray(items)) {
      errors.push(`${path}.${list}: expected a list`)
      continue
    }
    items.forEach((item, index) => {
      if (!isObject(item) || typeof item.id !== 'string' || typeof item.name !== 'string') {
        errors.push(`${path}.${list}[${index}]: expected an object with "id" and "name"`)
      }
    })
  }
  if (errors.length > before) return false
  ;(value.resources as JsonObject[]).forEach((resource, index) => {
    const fields = RESOURCE_FIELDS[resource.kind as ResourceKind]
    if (!fields) {
      errors.push(
        `${path}.resources[${index}].kind: "${String(resource.kind)}" is not a resource kind`,
      )
      return
    }
    for (const [field, type] of Object.entries(fields)) {
      if (typeof resource[field] !== type) {
        errors.push(
          `${path}.resources[${index}].${field}: expected ${type === 'object' ? 'a list or object' : `a ${type}`}`,
        )
      }
    }
  })
  return errors.length === before
}

export function validateLevel(value: unknown, knownFactCardIds: string[]): string[] {
  const errors: string[] = []
  if (!isObject(value)) return ['level: expected an object']

  // --- shape ---------------------------------------------------------------
  const expectType = (field: string, type: 'string' | 'number') => {
    if (typeof value[field] !== type) errors.push(`${field}: expected a ${type}`)
  }
  expectType('id', 'number')
  for (const field of ['slug', 'title', 'concept']) expectType(field, 'string')
  if (!['full', 'hints', 'minimal'].includes(value.guidance as string)) {
    errors.push('guidance: expected "full", "hints" or "minimal"')
  }
  if (!(REGION_CODES as readonly string[]).includes(value.region as string)) {
    errors.push(`region: expected one of ${REGION_CODES.join(', ')}`)
  }
  if (value.azs !== 1 && value.azs !== 2) errors.push('azs: expected 1 or 2')
  for (const list of [
    'narration',
    'lockedIds',
    'palette',
    'population',
    'events',
    'objectives',
    'hints',
    'factCards',
  ]) {
    if (!Array.isArray(value[list])) errors.push(`${list}: expected a list`)
  }
  const starsOk =
    isObject(value.stars) &&
    isObject(value.stars.wellArchitected) &&
    typeof value.stars.wellArchitected.text === 'string' &&
    Array.isArray(value.stars.wellArchitected.predicates)
  if (!starsOk) errors.push('stars.wellArchitected: expected { text, predicates }')
  const initialOk = checkSceneShape(value.initialScene, 'initialScene', errors)
  const referenceOk = checkSceneShape(value.referenceSolution, 'referenceSolution', errors)
  if (errors.length > 0 || !initialOk || !referenceOk) return errors

  // From here on the shape is right, so the value can be read as a Level.
  const level = value as unknown as Level

  // --- cross-references ------------------------------------------------------
  if (level.events.length > 0) errors.push('events: scripted events are not supported yet')

  for (const problem of validateScene(level.initialScene)) {
    if (problem.severity === 'broken-reference') errors.push(`initialScene: ${problem.message}`)
  }
  // The reference solution must be a sound architecture, not merely well-formed data.
  for (const problem of validateScene(level.referenceSolution)) {
    errors.push(`referenceSolution: ${problem.message}`)
  }

  const idsIn = (scene: Scene) =>
    new Set(
      [
        ...scene.resources,
        ...scene.securityGroups,
        ...scene.routeTables,
        ...scene.networkAcls,
        ...scene.subnets,
      ].map((item) => item.id),
    )
  const initialIds = idsIn(level.initialScene)
  const paletteIds = new Set(level.palette.map((entry) => entry.resource.id))
  const paletteGroupIds = new Set(
    level.palette.flatMap((entry) => (entry.securityGroups ?? []).map((group) => group.id)),
  )

  level.lockedIds.forEach((id, index) => {
    if (!initialIds.has(id)) errors.push(`lockedIds[${index}]: "${id}" is not in the initial scene`)
  })
  level.palette.forEach((entry, index) => {
    if (initialIds.has(entry.resource.id)) {
      errors.push(`palette[${index}]: "${entry.resource.id}" is already in the initial scene`)
    }
  })

  // The solution must be reachable: built only from the initial scene plus the palette.
  for (const resource of level.referenceSolution.resources) {
    if (!initialIds.has(resource.id) && !paletteIds.has(resource.id)) {
      errors.push(
        `referenceSolution: "${resource.id}" is neither in the initial scene nor in the palette`,
      )
    }
  }
  for (const group of level.referenceSolution.securityGroups) {
    if (!initialIds.has(group.id) && !paletteGroupIds.has(group.id)) {
      errors.push(
        `referenceSolution: security group "${group.id}" is neither in the initial scene nor in the palette`,
      )
    }
  }
  // ...and must leave locked things exactly as they were.
  const find = (scene: Scene, id: string) =>
    [...scene.resources, ...scene.securityGroups, ...scene.routeTables, ...scene.networkAcls].find(
      (item) => item.id === id,
    )
  for (const id of level.lockedIds) {
    if (
      JSON.stringify(find(level.initialScene, id)) !==
      JSON.stringify(find(level.referenceSolution, id))
    ) {
      errors.push(`referenceSolution: "${id}" is locked but differs from the initial scene`)
    }
  }

  const solutionIds = idsIn(level.referenceSolution)
  const kiteIds = new Set<string>()
  level.population.forEach((kite, index) => {
    const path = `population[${index}]`
    if (kiteIds.has(kite.id)) errors.push(`${path}.id: "${kite.id}" is used twice`)
    kiteIds.add(kite.id)
    if (kite.kind !== 'friendly' && kite.kind !== 'hostile')
      errors.push(`${path}.kind: expected "friendly" or "hostile"`)
    if (
      !Number.isInteger(kite.groundPosition) ||
      kite.groundPosition < 0 ||
      kite.groundPosition > 6
    ) {
      errors.push(`${path}.groundPosition: expected a whole number from 0 to 6`)
    }
    if (
      typeof kite.ip !== 'string' ||
      !DOCUMENTATION_RANGES.some((range) => safeContains(range, kite.ip))
    ) {
      errors.push(`${path}.ip: expected an address in ${DOCUMENTATION_RANGES.join(', ')}`)
    }
    if (!solutionIds.has(kite.destinationId)) {
      errors.push(
        `${path}.destinationId: "${kite.destinationId}" does not exist in the reference solution`,
      )
    }
    if (kite.backendCall && !solutionIds.has(kite.backendCall.destinationId)) {
      errors.push(
        `${path}.backendCall.destinationId: "${kite.backendCall.destinationId}" does not exist in the reference solution`,
      )
    }
    if (typeof kite.label !== 'string') errors.push(`${path}.label: expected a string`)
  })

  const objectiveIds = new Set(level.objectives.map((objective) => objective.id))
  if (objectiveIds.size !== level.objectives.length)
    errors.push('objectives: two objectives share an id')
  if (level.objectives.length === 0) errors.push('objectives: a level needs at least one objective')
  level.hints.forEach((hint, index) => {
    if (!objectiveIds.has(hint.objectiveId)) {
      errors.push(
        `hints[${index}].objectiveId: "${hint.objectiveId}" is not an objective of this level`,
      )
    }
  })
  for (const objective of level.objectives) {
    if (!level.hints.some((hint) => hint.objectiveId === objective.id)) {
      errors.push(`hints: objective "${objective.id}" has no hint`)
    }
  }
  level.factCards.forEach((id, index) => {
    if (!knownFactCardIds.includes(id))
      errors.push(`factCards[${index}]: there is no fact card "${id}"`)
  })
  if (level.guidance === 'full' && level.narration.length === 0) {
    errors.push('narration: a fully guided level needs narrator steps')
  }

  return errors
}

function safeContains(range: string, ip: string): boolean {
  try {
    return cidrContains(range, ip)
  } catch {
    return false
  }
}
