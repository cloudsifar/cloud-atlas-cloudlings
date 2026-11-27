// The art substitution framework (ADR 0016): every visual the game draws has an entry
// in assets/manifest.json, the code asks for every entry it draws, and the list of art
// to make (docs/ASSET_LIST.md) is generated from the same manifest. So final art can be
// dropped in, one picture at a time, without a code change.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderAssetList } from '../../tools/asset-list.mjs'
import manifest from '../../assets/manifest.json'
import {
  ART,
  artPoint,
  cloudlingArtId,
  frameIndex,
  isArtId,
  kiteArtId,
  regionArtId,
  type ArtId,
} from '../../src/game/art'
import { GENUS_OF, spriteIdOf } from '../../src/game/layout'
import { REGION_CODES } from '../../src/levels'

const ids = Object.keys(ART) as ArtId[]
const drawn = ids.filter((id) => ART[id].status !== 'planned')
const planned = ids.filter((id) => ART[id].status === 'planned')

/** Every source file of the game and its interface, as text. */
const sources = ['src/game', 'src/ui']
  .flatMap((dir) => readdirSync(dir).map((name) => join(dir, name)))
  .filter((path) => path.endsWith('.ts'))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')
/** The stylesheet, where interface art is a custom property: `--art-ui-narrator-idle`. */
const stylesheet = readFileSync('src/ui/styles.css', 'utf8')
const askedFor = (id: string) =>
  sources.includes(`'${id}'`) || stylesheet.includes(`--art-${id.replaceAll('.', '-')}`)

const KITE_STATES = ['flying', 'tangled', 'netted', 'crumpled']
const MOODS = {
  friendly: ['idle', 'cheer', 'droop'],
  hostile: ['idle', 'stamp', 'snicker'],
  // The operator (Level 9): answered or turned away, like a friendly Cloudling.
  operator: ['idle', 'cheer', 'droop'],
}
const SIDES = ['friendly', 'hostile', 'operator'] as const

/** The ids the code builds from game state rather than writing out. */
const built = new Set<string>([
  ...Object.keys(GENUS_OF).map((kind) => spriteIdOf(kind as keyof typeof GENUS_OF)),
  ...REGION_CODES.flatMap((region) =>
    (['skyline', 'ground', 'costume'] as const).map((part) => regionArtId(region, part) ?? ''),
  ),
  ...Object.entries(MOODS).flatMap(([side, moods]) =>
    moods.map((mood) => cloudlingArtId(side as (typeof SIDES)[number], mood)),
  ),
  ...SIDES.flatMap((side) => KITE_STATES.map((state) => kiteArtId(side, state))),
])

describe('the manifest covers everything the game draws', () => {
  it('has a picture entry for every kind of cloud, drawn, not planned', () => {
    for (const kind of Object.keys(GENUS_OF)) {
      const id = spriteIdOf(kind as keyof typeof GENUS_OF)
      expect(isArtId(id)).toBe(true)
      expect(ART[id].status).toBeUndefined()
    }
  })

  it('has a skyline, a ground strip and a costume overlay for every region', () => {
    for (const region of REGION_CODES)
      for (const part of ['skyline', 'ground', 'costume'] as const)
        expect(regionArtId(region, part)).not.toBeNull()
  })

  it('has a Cloudling for every mood the game shows, and a kite for every state', () => {
    for (const [side, moods] of Object.entries(MOODS))
      for (const mood of moods) expect(isArtId(`cloudling.${side}.${mood}`)).toBe(true)
    for (const side of SIDES)
      for (const state of KITE_STATES) expect(isArtId(`kite.${side}.${state}`)).toBe(true)
    // A Cloudling with a hand to hold the string.
    for (const id of ids.filter((candidate) =>
      /^cloudling\.(friendly|hostile|operator)\./.test(candidate),
    ))
      expect(ART[id].points?.hand).toBeDefined()
  })

  it('has the weather station in parts, so its hand can turn and its bell swing', () => {
    for (const part of ['body', 'anemometer', 'dial', 'needle', 'bell'])
      expect(isArtId(`station.${part}`)).toBe(true)
  })
})

describe('every drawn entry is asked for by the code', () => {
  it('finds each drawn id built from game state or written in the drawing code', () => {
    for (const id of drawn) {
      const asked = built.has(id) || askedFor(id)
      expect({ id, asked }).toEqual({ id, asked: true })
    }
  })

  it('draws nothing marked planned: an entry is planned until its hook exists', () => {
    for (const id of planned) expect(askedFor(id)).toBe(false)
  })
})

describe('every entry is complete', () => {
  it('has a size, an anchor inside the picture, a group, a priority and a description', () => {
    for (const id of ids) {
      const entry = ART[id]
      expect(entry.width).toBeGreaterThan(0)
      expect(entry.height).toBeGreaterThan(0)
      for (const fraction of entry.anchor) {
        expect(fraction).toBeGreaterThanOrEqual(0)
        expect(fraction).toBeLessThanOrEqual(1)
      }
      expect(entry.group.length).toBeGreaterThan(0)
      expect([1, 2, 3]).toContain(entry.priority)
      expect(entry.description.length).toBeGreaterThan(20)
    }
  })

  it('names only pictures that are really in public/art/', () => {
    for (const id of ids)
      for (const file of [ART[id].file, ART[id].highlight])
        if (file) expect(existsSync(join('public/art', file))).toBe(true)
  })

  it('keeps docs/ASSET_LIST.md in step with the manifest (npm run assets:list)', () => {
    expect(readFileSync('docs/ASSET_LIST.md', 'utf8')).toBe(renderAssetList(manifest))
  })
})

describe('drawing from a strip of frames', () => {
  it('shows the frame for the time, looping, and the first for a single picture', () => {
    expect(frameIndex({}, 5000)).toBe(0)
    expect(frameIndex({ frames: 4, fps: 8 }, 0)).toBe(0)
    expect(frameIndex({ frames: 4, fps: 8 }, 125)).toBe(1)
    expect(frameIndex({ frames: 4, fps: 8 }, 499)).toBe(3)
    expect(frameIndex({ frames: 4, fps: 8 }, 500)).toBe(0)
    expect(frameIndex({ frames: 4, fps: 8 }, -100)).toBe(0)
  })

  it('places a named point, such as a Cloudling’s hand, from its fractions and the anchor', () => {
    const id: ArtId = 'cloudling.friendly.idle'
    const entry = ART[id]
    const hand = artPoint(id, 'hand', { x: 100, y: 200 })!
    expect(hand.x).toBeCloseTo(100 + (entry.points!.hand![0] - entry.anchor[0]) * entry.width, 6)
    expect(hand.y).toBeCloseTo(200 + (entry.points!.hand![1] - entry.anchor[1]) * entry.height, 6)
    expect(artPoint(id, 'nose', { x: 0, y: 0 })).toBeNull()
  })

  it('falls back to a picture that exists for a mood or state with none of its own', () => {
    expect(cloudlingArtId('hostile', 'cheer')).toBe('cloudling.hostile.idle')
    expect(kiteArtId('friendly', 'spinning')).toBe('kite.friendly.flying')
  })
})
