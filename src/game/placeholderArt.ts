// Placeholder art, drawn in code until the final illustrations arrive.
//
// Clouds follow the two-layer scheme the final art will use (docs/ASSET_LIST.md):
//  - a light, near-neutral BASE layer (shape, pencil outline, hatching) that code tints, and
//  - a HIGHLIGHT layer (a soft inner glow) that carries golden sunlight and the white burst.
// Tinting is done by multiplying the base with a colour, so the pencil texture survives.
// Each genus has its own silhouette so service families can be told apart by shape alone.

import type { CloudGenus } from './layout'

export const PENCIL = '#55525f'
export const CAPTION_FONT =
  '"Patrick Hand", "Segoe Print", "Bradley Hand", "Chalkboard SE", "Comic Sans MS", cursive'

/** An ellipse as [centre x, centre y, radius x, radius y], in fractions of the sprite's width and height. */
type Ellipse = [number, number, number, number]

/**
 * Each genus is a list of puff groups. A group is outlined as one shape;
 * separate groups stay separate (altocumulus is a patch of small cloudlets).
 */
const SILHOUETTES: Record<Exclude<CloudGenus, 'cirrus'>, Ellipse[][]> = {
  // The classic puffy cloud with a flat base.
  cumulus: [
    [
      [0.5, 0.72, 0.44, 0.24],
      [0.14, 0.62, 0.11, 0.3],
      [0.3, 0.42, 0.13, 0.36],
      [0.5, 0.34, 0.14, 0.32],
      [0.7, 0.42, 0.13, 0.36],
      [0.86, 0.62, 0.11, 0.3],
    ],
  ],
  // A low layer of lumps.
  stratocumulus: [
    [
      [0.5, 0.7, 0.44, 0.24],
      [0.22, 0.52, 0.17, 0.3],
      [0.5, 0.44, 0.19, 0.34],
      [0.78, 0.52, 0.17, 0.3],
    ],
  ],
  // Patches of many small cloudlets: a fleet.
  altocumulus: [
    [
      [0.24, 0.3, 0.17, 0.2],
      [0.36, 0.26, 0.12, 0.17],
    ],
    [
      [0.7, 0.28, 0.17, 0.2],
      [0.82, 0.33, 0.11, 0.15],
    ],
    [
      [0.38, 0.7, 0.19, 0.21],
      [0.24, 0.74, 0.11, 0.15],
    ],
    [[0.78, 0.72, 0.16, 0.19]],
  ],
  // Enormous and vertical: a tower with an anvil top.
  cumulonimbus: [
    [
      [0.5, 0.07, 0.48, 0.055],
      [0.5, 0.16, 0.32, 0.08],
      [0.46, 0.3, 0.3, 0.1],
      [0.54, 0.44, 0.33, 0.1],
      [0.47, 0.58, 0.34, 0.1],
      [0.53, 0.72, 0.38, 0.1],
      [0.5, 0.88, 0.46, 0.1],
    ],
  ],
}

function tracePuffs(
  context: CanvasRenderingContext2D,
  puffs: Ellipse[],
  width: number,
  height: number,
): void {
  context.beginPath()
  for (const [cx, cy, rx, ry] of puffs) {
    context.moveTo(cx * width + rx * width, cy * height)
    context.ellipse(cx * width, cy * height, rx * width, ry * height, 0, 0, Math.PI * 2)
  }
}

function newCanvas(
  width: number,
  height: number,
): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width)
  canvas.height = Math.ceil(height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is not available')
  return { canvas, context }
}

/** Thin strands with hooked ends: cirrus has no body to fill, only threads. */
function drawCirrusBase(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.strokeStyle = '#8f8c99'
  context.lineCap = 'round'
  for (let strand = 0; strand < 5; strand++) {
    const y = height * (0.2 + strand * 0.15)
    const startX = width * (0.06 + (strand % 2) * 0.08)
    context.lineWidth = 2.6 - strand * 0.25
    context.beginPath()
    context.moveTo(startX, y + 6)
    context.bezierCurveTo(width * 0.3, y - 8, width * 0.62, y + 8, width * 0.9, y - 4)
    context.quadraticCurveTo(width * 0.97, y - 9, width * 0.93, y - 13) // the hook
    context.stroke()
  }
}

function drawPuffBase(
  context: CanvasRenderingContext2D,
  groups: Ellipse[][],
  width: number,
  height: number,
): void {
  for (const puffs of groups) {
    // Outline trick: stroke every ellipse, then fill them all. The fill hides the
    // strokes that fall inside the shape, leaving one pencil line around the union.
    tracePuffs(context, puffs, width, height)
    context.lineWidth = 3.4
    context.strokeStyle = PENCIL
    context.stroke()
    context.fillStyle = '#fcfcfc'
    context.fill()

    // Diagonal hatching inside the shape, for a pencil feel.
    context.save()
    tracePuffs(context, puffs, width, height)
    context.clip()
    context.strokeStyle = 'rgba(70, 70, 90, 0.16)'
    context.lineWidth = 1
    for (let offset = -height; offset < width + height; offset += 7) {
      context.beginPath()
      context.moveTo(offset, height)
      context.lineTo(offset + height * 0.8, height * 0.45)
      context.stroke()
    }
    context.restore()
  }
}

export type CloudSprite = {
  width: number
  height: number
  /** Near-neutral shape + outline + hatching, to be tinted. */
  base: HTMLCanvasElement
  /** Soft inner glow in white, to be coloured gold (sunlight) or left white (burst). */
  highlight: HTMLCanvasElement
}

const PADDING = 4
const spriteCache = new Map<string, CloudSprite>()

export function cloudSprite(genus: CloudGenus, width: number, height: number): CloudSprite {
  const key = `${genus}:${width}x${height}`
  const cached = spriteCache.get(key)
  if (cached) return cached

  const base = newCanvas(width + PADDING * 2, height + PADDING * 2)
  base.context.translate(PADDING, PADDING)
  const highlight = newCanvas(width + PADDING * 2, height + PADDING * 2)
  highlight.context.translate(PADDING, PADDING)

  if (genus === 'cirrus') {
    drawCirrusBase(base.context, width, height)
    drawCirrusBase(highlight.context, width, height)
  } else {
    const groups = SILHOUETTES[genus]
    drawPuffBase(base.context, groups, width, height)
    const glow = highlight.context.createRadialGradient(
      width / 2,
      height / 2,
      0,
      width / 2,
      height / 2,
      Math.max(width, height) / 2,
    )
    glow.addColorStop(0, 'rgba(255,255,255,1)')
    glow.addColorStop(1, 'rgba(255,255,255,0.25)')
    highlight.context.fillStyle = glow
    for (const puffs of groups) {
      tracePuffs(highlight.context, puffs, width, height)
      highlight.context.fill()
    }
  }

  const sprite = { width, height, base: base.canvas, highlight: highlight.canvas }
  spriteCache.set(key, sprite)
  return sprite
}

const tintCache = new Map<string, HTMLCanvasElement>()

/** A layer multiplied by a colour (or vertical gradient of colours), keeping the layer's own transparency. */
function tinted(
  layer: HTMLCanvasElement,
  key: string,
  colours: string[],
  mode: 'multiply' | 'source-in',
): HTMLCanvasElement {
  const cacheKey = `${key}:${mode}:${colours.join(',')}`
  const cached = tintCache.get(cacheKey)
  if (cached) return cached
  const { canvas, context } = newCanvas(layer.width, layer.height)
  context.drawImage(layer, 0, 0)
  context.globalCompositeOperation = mode
  const gradient = context.createLinearGradient(0, 0, 0, layer.height)
  colours.forEach((colour, index) =>
    gradient.addColorStop(colours.length === 1 ? 0 : index / (colours.length - 1), colour),
  )
  context.fillStyle = gradient
  context.fillRect(0, 0, layer.width, layer.height)
  // Multiply paints over transparent pixels too; cut the result back to the layer's shape.
  context.globalCompositeOperation = 'destination-in'
  context.drawImage(layer, 0, 0)
  tintCache.set(cacheKey, canvas)
  return canvas
}

export type CloudLook = {
  /** One colour, or several for a top-to-bottom gradient (the S3 cloud shades through every band). */
  tint: string[]
  /** 0 to 1: golden sunlight, shown briefly when a change takes effect. */
  sunlight: number
  /** 0 to 1: the white burst when a kite is delivered. */
  burst: number
  opacity: number
}

export function drawCloud(
  context: CanvasRenderingContext2D,
  genus: CloudGenus,
  x: number,
  y: number,
  width: number,
  height: number,
  look: CloudLook,
): void {
  const sprite = cloudSprite(genus, width, height)
  const key = `${genus}:${width}x${height}`
  context.save()
  context.globalAlpha = look.opacity
  context.drawImage(tinted(sprite.base, key, look.tint, 'multiply'), x - PADDING, y - PADDING)
  if (look.sunlight > 0) {
    context.globalAlpha = look.opacity * look.sunlight * 0.85
    context.drawImage(
      tinted(sprite.highlight, key + ':hl', ['#f5c542'], 'source-in'),
      x - PADDING,
      y - PADDING,
    )
  }
  if (look.burst > 0) {
    context.globalAlpha = look.opacity * look.burst
    context.drawImage(sprite.highlight, x - PADDING, y - PADDING)
  }
  context.restore()
}

// ---------------------------------------------------------------------------
// Cloudlings and kites
// ---------------------------------------------------------------------------

export type Mood = 'idle' | 'cheer' | 'droop' | 'stamp' | 'snicker'

const SKIN = '#bdb6d0' // soft cloud grey-lilac: belongs to no region and suits them all
const HAIR = '#5b5470'

/**
 * Draws a Cloudling with its feet at (x, y) and returns the hand that holds the string.
 * `costume` is the colour of the regional outfit; hostile Cloudlings always wear the black hoodie.
 */
export function drawCloudling(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  hostile: boolean,
  mood: Mood,
  costume: string,
  time: number,
): { x: number; y: number } {
  const jump = mood === 'cheer' ? Math.abs(Math.sin(time / 110)) * 9 : 0
  const shake = mood === 'stamp' ? Math.sin(time / 35) * 2.5 : 0
  const sag = mood === 'droop' ? 4 : 0
  const feetY = y - jump
  const centreX = x + shake

  context.save()
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = PENCIL
  context.lineWidth = 1.5

  // Legs and boots.
  const stamp = mood === 'stamp' && Math.sin(time / 70) > 0 ? -4 : 0
  for (const side of [-1, 1]) {
    context.beginPath()
    context.moveTo(centreX + side * 4, feetY - 20)
    context.lineTo(centreX + side * 4, feetY - 2 + (side === 1 ? stamp : 0))
    context.lineWidth = 4
    context.strokeStyle = hostile ? '#2a2a30' : '#4d5a78'
    context.stroke()
  }

  // Body: the costume layer.
  context.lineWidth = 1.5
  context.strokeStyle = PENCIL
  context.fillStyle = hostile ? '#26262c' : costume
  context.beginPath()
  context.roundRect(centreX - 9, feetY - 42 + sag, 18, 24, 6)
  context.fill()
  context.stroke()

  // Arms: one holds the string; both go up in a cheer.
  const hand = { x: centreX + 13, y: feetY - (mood === 'cheer' ? 56 : 46) + sag * 2 }
  context.beginPath()
  context.moveTo(centreX + 7, feetY - 37 + sag)
  context.lineTo(hand.x, hand.y)
  context.moveTo(centreX - 7, feetY - 37 + sag)
  context.lineTo(centreX - 13, feetY - (mood === 'cheer' ? 56 : 26) + sag)
  context.stroke()

  // Head, drawn a little large so the face reads at crowd sizes.
  const headY = feetY - 51 + sag * 1.6
  if (hostile) {
    // Hood up: only the eyes show.
    context.fillStyle = '#26262c'
    context.beginPath()
    context.arc(centreX, headY, 10.5, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    context.fillStyle = '#101014'
    context.beginPath()
    context.ellipse(centreX + 1, headY + 1, 6.5, 5, 0, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#ffffff'
    const squint = mood === 'snicker' ? 1.1 : 1.9
    context.beginPath()
    context.ellipse(centreX - 1.8, headY + 0.5, 1.7, squint, 0, 0, Math.PI * 2)
    context.ellipse(centreX + 3.8, headY + 0.5, 1.7, squint, 0, 0, Math.PI * 2)
    context.fill()
  } else {
    context.fillStyle = SKIN
    context.beginPath()
    context.arc(centreX, headY, 9, 0, Math.PI * 2)
    context.fill()
    context.stroke()
    // The short bob everyone shares.
    context.fillStyle = HAIR
    context.beginPath()
    context.arc(centreX, headY - 1, 9.4, Math.PI * 0.95, Math.PI * 2.05)
    context.lineTo(centreX + 9, headY + 4)
    context.lineTo(centreX + 6, headY - 2)
    context.lineTo(centreX - 6, headY - 2)
    context.lineTo(centreX - 9, headY + 4)
    context.closePath()
    context.fill()
    // Eyes and mouth carry the mood.
    context.fillStyle = '#2d2a3a'
    context.beginPath()
    context.arc(centreX - 3, headY + 1.5, 1.1, 0, Math.PI * 2)
    context.arc(centreX + 3, headY + 1.5, 1.1, 0, Math.PI * 2)
    context.fill()
    context.beginPath()
    context.lineWidth = 1.1
    if (mood === 'droop') context.arc(centreX, headY + 7, 2.6, Math.PI * 1.15, Math.PI * 1.85)
    else context.arc(centreX, headY + 3.4, 2.8, Math.PI * 0.15, Math.PI * 0.85)
    context.stroke()
  }
  context.restore()
  return hand
}

export type KiteState = 'flying' | 'crumpled' | 'tangled'

/**
 * Friendly kites are green diamonds; hostile kites are red and shaped like a bird
 * of prey. The shapes differ so the game does not rely on colour.
 */
export function drawKite(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  hostile: boolean,
  state: KiteState,
  time: number,
  scale = 1,
): void {
  context.save()
  context.translate(x, y)
  const sway = state === 'flying' ? Math.sin(time / 420 + x) * 0.12 : 0
  const tangle = state === 'tangled' ? Math.sin(time / 45) * 0.5 : 0
  context.rotate(sway + tangle + (state === 'crumpled' ? 1.2 : 0))
  context.scale(scale * (state === 'crumpled' ? 0.7 : 1), scale * (state === 'crumpled' ? 0.45 : 1))
  context.strokeStyle = PENCIL
  context.lineWidth = 1.5
  context.lineJoin = 'round'

  context.beginPath()
  if (hostile) {
    const outline: [number, number][] = [
      [-23, -5],
      [-11, -11],
      [0, -4],
      [11, -11],
      [23, -5],
      [13, 2],
      [5, 4],
      [0, 13],
      [-5, 4],
      [-13, 2],
    ]
    outline.forEach(([px, py], index) =>
      index === 0 ? context.moveTo(px, py) : context.lineTo(px, py),
    )
    context.closePath()
    context.fillStyle = '#c9463d'
  } else {
    context.moveTo(0, -19)
    context.lineTo(13, -2)
    context.lineTo(0, 19)
    context.lineTo(-13, -2)
    context.closePath()
    context.fillStyle = '#5aa861'
  }
  context.fill()
  context.stroke()

  if (hostile) {
    // A hooked beak and an eye, so the silhouette reads as a raptor.
    context.beginPath()
    context.moveTo(0, -4)
    context.lineTo(3, 0)
    context.lineTo(0, 2)
    context.stroke()
  } else {
    // Cross spars and a bow-tied tail.
    context.beginPath()
    context.moveTo(0, -19)
    context.lineTo(0, 19)
    context.moveTo(-13, -2)
    context.lineTo(13, -2)
    context.moveTo(0, 19)
    context.quadraticCurveTo(7, 27, 0, 34)
    context.stroke()
  }
  context.restore()
}

/** The kite string: a gentle curve from the Cloudling's hand to the kite. */
export function drawString(
  context: CanvasRenderingContext2D,
  hand: { x: number; y: number },
  kite: { x: number; y: number },
  slack: number,
  time: number,
): void {
  const middle = { x: (hand.x + kite.x) / 2, y: (hand.y + kite.y) / 2 }
  const sway = Math.sin(time / 600 + hand.x) * 6
  context.save()
  context.strokeStyle = 'rgba(70, 66, 82, 0.75)'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(hand.x, hand.y)
  context.quadraticCurveTo(middle.x + 14 + sway, middle.y + 10 + slack * 60, kite.x, kite.y)
  context.stroke()
  context.restore()
}
