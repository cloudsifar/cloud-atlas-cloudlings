// Final art: the pictures that will replace the placeholders, and how they are drawn.
//
// Every visual the game draws has an entry in assets/manifest.json: its picture (none
// yet), its size and anchor, its frames and its named points. Each drawing function
// asks here first and draws the picture if it has loaded; otherwise it draws its
// placeholder, as it always has. So swapping in final art is a file in public/art/ and
// a `file` name in the manifest, never a code change (brief, Section 11).
//
// docs/ASSET_LIST.md, the list of art to make, is generated from the same manifest
// (`npm run assets:list`), and tests/game/art.test.ts checks that every drawn entry is
// asked for by the code and every resource, region, mood and kite state has an entry.

import manifest from '../../assets/manifest.json'
import type { Point, Rect } from './layout'

export type ArtId = keyof typeof manifest.sprites

export type ArtEntry = {
  /** The picture, a file name in public/art/; null until the final art exists. */
  file: string | null
  /** A cloud's highlight layer (sunlight and the white burst), if it has its own picture. */
  highlight?: string | null
  width: number
  height: number
  /** The point of the sprite placed on its position, as fractions of its width and height. */
  anchor: [number, number]
  /** Frames side by side in one strip, and how fast they play. */
  frames?: number
  fps?: number
  /** Named places on the sprite, as fractions: a Cloudling's hand. */
  points?: Record<string, [number, number]>
  /** Between two points: stretched (default) or tiled along the way. */
  repeat?: 'stretch' | 'tile'
  states?: string
  /** Not drawn yet: listed so the art can be made, hooked up with its feature. */
  status?: 'planned'
  group: string
  priority: 1 | 2 | 3
  description: string
}

export const ART = manifest.sprites as unknown as Record<ArtId, ArtEntry>

/** Where final pictures are served from: public/art/, copied to the top of dist/ by both builds. */
export const ART_FOLDER = 'art'

export function isArtId(id: string): id is ArtId {
  return Object.prototype.hasOwnProperty.call(ART, id)
}

const pictures = new Map<string, HTMLImageElement>()
let generation = 0

/** Bumps each time a picture arrives, so caches built from pictures know to rebuild. */
export function artGeneration(): number {
  return generation
}

/**
 * Loads every picture the manifest names. Each one that arrives is drawn from then on;
 * one that fails to load leaves its placeholder. `onChange` is told when one arrives.
 * Interface pictures (ids starting `ui.`) are also offered to the stylesheet as
 * `--art-<id>` (dots as dashes), e.g. `--art-ui-narrator-idle`.
 */
export function loadArt(onChange?: () => void): void {
  if (typeof Image === 'undefined') return
  const wanted = new Map<string, ArtId[]>()
  for (const id of Object.keys(ART) as ArtId[]) {
    for (const file of [ART[id].file, ART[id].highlight]) {
      if (file) wanted.set(file, [...(wanted.get(file) ?? []), id])
    }
  }
  for (const [file, ids] of wanted) {
    const picture = new Image()
    picture.onload = () => {
      pictures.set(file, picture)
      generation++
      for (const id of ids.filter((candidate) => candidate.startsWith('ui.'))) {
        document.documentElement.style.setProperty(
          `--art-${id.replaceAll('.', '-')}`,
          `url("${ART_FOLDER}/${file}")`,
        )
      }
      onChange?.()
    }
    picture.onerror = () =>
      console.warn(`Art "${file}" could not load from ${ART_FOLDER}/; its placeholder stays.`)
    picture.src = `${ART_FOLDER}/${file}`
  }
}

/** The picture for an entry, once it has loaded; null while the placeholder is in use. */
export function artPicture(id: ArtId): HTMLImageElement | null {
  const file = ART[id].file
  return file ? (pictures.get(file) ?? null) : null
}

/** A cloud's own highlight picture, if it has one and it has loaded. */
export function artHighlight(id: ArtId): HTMLImageElement | null {
  const file = ART[id].highlight
  return file ? (pictures.get(file) ?? null) : null
}

/** Which frame of a strip is on show at `time` (milliseconds). Frames run left to right. */
export function frameIndex(entry: Pick<ArtEntry, 'frames' | 'fps'>, time: number): number {
  const frames = entry.frames ?? 1
  if (frames <= 1) return 0
  const frame = Math.floor((Math.max(0, time) / 1000) * (entry.fps ?? 8))
  return frame % frames
}

/** A named point on a sprite placed with its anchor at `at`, at `scale`. */
export function artPoint(id: ArtId, name: string, at: Point, scale = 1): Point | null {
  const entry = ART[id]
  const point = entry.points?.[name]
  if (!point) return null
  return {
    x: at.x + (point[0] - entry.anchor[0]) * entry.width * scale,
    y: at.y + (point[1] - entry.anchor[1]) * entry.height * scale,
  }
}

type DrawOptions = {
  /** Animation time in milliseconds, for a strip of frames. */
  time?: number
  /** A frame to show instead of the one `time` gives. */
  frame?: number
  alpha?: number
}

function drawFrame(
  context: CanvasRenderingContext2D,
  id: ArtId,
  picture: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  options: DrawOptions,
): void {
  const entry = ART[id]
  const frames = entry.frames ?? 1
  const frame = (options.frame ?? frameIndex(entry, options.time ?? 0)) % frames
  const sourceWidth = picture.naturalWidth / frames
  context.drawImage(
    picture,
    frame * sourceWidth,
    0,
    sourceWidth,
    picture.naturalHeight,
    x,
    y,
    width,
    height,
  )
}

/** Draws an entry's picture filling a box. Returns false, drawing nothing, if there is none yet. */
export function drawArt(
  context: CanvasRenderingContext2D,
  id: ArtId,
  rect: Rect,
  options: DrawOptions = {},
): boolean {
  const picture = artPicture(id)
  if (!picture) return false
  context.save()
  if (options.alpha !== undefined) context.globalAlpha *= options.alpha
  drawFrame(context, id, picture, rect.x, rect.y, rect.width, rect.height, options)
  context.restore()
  return true
}

/**
 * Draws an entry's picture with its anchor on `at`, at its manifest size times `scale`,
 * turned by `angle` (radians) about the anchor. Returns false if there is no picture yet.
 */
export function drawArtAt(
  context: CanvasRenderingContext2D,
  id: ArtId,
  at: Point,
  options: DrawOptions & { scale?: number; angle?: number } = {},
): boolean {
  const picture = artPicture(id)
  if (!picture) return false
  const entry = ART[id]
  const scale = options.scale ?? 1
  const width = entry.width * scale
  const height = entry.height * scale
  context.save()
  if (options.alpha !== undefined) context.globalAlpha *= options.alpha
  context.translate(at.x, at.y)
  if (options.angle) context.rotate(options.angle)
  drawFrame(
    context,
    id,
    picture,
    -entry.anchor[0] * width,
    -entry.anchor[1] * height,
    width,
    height,
    options,
  )
  context.restore()
  return true
}

/**
 * Draws an entry's picture from one point to another, turned to follow the line and
 * centred on it at its manifest height: stretched, or repeated along the way when the
 * entry says `repeat: "tile"`. Returns false if there is no picture yet.
 */
export function drawArtBetween(
  context: CanvasRenderingContext2D,
  id: ArtId,
  from: Point,
  to: Point,
  options: DrawOptions = {},
): boolean {
  const picture = artPicture(id)
  if (!picture) return false
  const entry = ART[id]
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  if (length === 0) return true
  context.save()
  if (options.alpha !== undefined) context.globalAlpha *= options.alpha
  context.translate(from.x, from.y)
  context.rotate(Math.atan2(to.y - from.y, to.x - from.x))
  const top = -entry.anchor[1] * entry.height
  if (entry.repeat === 'tile') {
    for (let start = 0; start < length; start += entry.width) {
      const width = Math.min(entry.width, length - start)
      const share = width / entry.width
      context.drawImage(
        picture,
        0,
        0,
        picture.naturalWidth * share,
        picture.naturalHeight,
        start,
        top,
        width,
        entry.height,
      )
    }
  } else {
    drawFrame(context, id, picture, 0, top, length, entry.height, options)
  }
  context.restore()
  return true
}

// ---------------------------------------------------------------------------
// Ids built from game state: the code asks for these, the tests check each exists.
// ---------------------------------------------------------------------------

export type CloudlingSide = 'friendly' | 'hostile'

/** A Cloudling's picture for a mood, or its idle one if that mood has none. */
export function cloudlingArtId(side: CloudlingSide, mood: string): ArtId {
  const wanted = `cloudling.${side}.${mood}`
  return isArtId(wanted) ? wanted : (`cloudling.${side}.idle` as ArtId)
}

/** A kite's picture in a state: flying, tangled, netted or crumpled. */
export function kiteArtId(side: CloudlingSide, state: string): ArtId {
  const wanted = `kite.${side}.${state}`
  return isArtId(wanted) ? wanted : (`kite.${side}.flying` as ArtId)
}

/** A region's skyline, ground strip or costume overlay. */
export function regionArtId(region: string, part: 'skyline' | 'ground' | 'costume'): ArtId | null {
  const wanted = part === 'costume' ? `cloudling.costume.${region}` : `scene.${region}.${part}`
  return isArtId(wanted) ? wanted : null
}
