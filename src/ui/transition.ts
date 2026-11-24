// Moving between levels (ADR 0010). Pressing "Next level" dissolves the old sky into
// big, blurred pixels over two seconds; the new level's number and name appear in the
// middle of the screen; then the title fades and the new sky sharpens into view. A
// level chosen from the menu skips the dissolve and starts at the title.
//
// The pixels come from an SVG filter (sample one dot per block, then spread it across
// the block), animated together with a CSS blur. It applies to the game layer only, so
// the title above it stays crisp. With reduced motion the title simply appears and goes.

import { playSound, prefersReducedMotion } from '../game'
import type { Level } from '../levels'
import { h } from './dom'

/** How long the old sky takes to dissolve. */
export const DISSOLVE_MS = 2000
/** How long the new level's title stays up. */
export const TITLE_HOLD_MS = 1400
/** How long the new sky takes to sharpen while the title fades. */
export const REVEAL_MS = 800

/** The coarsest blocks and the strongest blur, at the peak of the transition. */
const MAX_BLOCK = 32
const MAX_BLUR = 6
const FILTER_ID = 'cloudlings-pixelate'
const SVG_NS = 'http://www.w3.org/2000/svg'

/** The filter's settings for blocks of about `block` pixels. */
export function pixelFilterParams(block: number): { tile: number; offset: number; radius: number } {
  const tile = Math.max(1, Math.round(block))
  const half = Math.floor(tile / 2)
  return { tile, offset: half, radius: half }
}

type PixelFilter = { flood: SVGElement; tileSource: SVGElement; dilate: SVGElement }
let filter: PixelFilter | null = null

/** Builds the SVG filter once, hidden at the end of the page. */
function pixelFilter(): PixelFilter {
  if (filter) return filter
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.position = 'absolute'
  const element = document.createElementNS(SVG_NS, 'filter')
  element.setAttribute('id', FILTER_ID)
  element.setAttribute('x', '0')
  element.setAttribute('y', '0')
  element.setAttribute('width', '1')
  element.setAttribute('height', '1')
  element.setAttribute('color-interpolation-filters', 'sRGB')
  const make = (name: string, attributes: Record<string, string>): SVGElement => {
    const node = document.createElementNS(SVG_NS, name)
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
    element.append(node)
    return node
  }
  // One dot in the middle of each block…
  const flood = make('feFlood', { x: '0', y: '0', width: '1', height: '1' })
  const tileSource = make('feComposite', { width: '1', height: '1' })
  make('feTile', { result: 'dots' })
  // …takes the colour under it, and is spread across the whole block.
  make('feComposite', { in: 'SourceGraphic', in2: 'dots', operator: 'in' })
  const dilate = make('feMorphology', { operator: 'dilate', radius: '0' })
  svg.append(element)
  document.body.append(svg)
  filter = { flood, tileSource, dilate }
  return filter
}

/** Sets how dissolved `target` looks, from 0 (sharp, no filter at all) to 1 (fully). */
function setDissolve(target: HTMLElement, amount: number): void {
  if (amount <= 0.001) {
    target.style.filter = ''
    return
  }
  const { flood, tileSource, dilate } = pixelFilter()
  const { tile, offset, radius } = pixelFilterParams(1 + amount * (MAX_BLOCK - 1))
  flood.setAttribute('x', String(offset))
  flood.setAttribute('y', String(offset))
  tileSource.setAttribute('width', String(tile))
  tileSource.setAttribute('height', String(tile))
  dilate.setAttribute('radius', String(radius))
  target.style.filter = `url(#${FILTER_ID}) blur(${(amount * MAX_BLUR).toFixed(2)}px)`
}

const easeIn = (t: number): number => t * t
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t)

function animate(durationMs: number, step: (progress: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now()
    const frame = (now: number): void => {
      const progress = Math.min(1, (now - start) / durationMs)
      step(progress)
      if (progress < 1) requestAnimationFrame(frame)
      else resolve()
    }
    requestAnimationFrame(frame)
  })
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

let busy = false

/**
 * Plays the move into `level`. `swap` mounts the new level; it runs at the peak of the
 * transition, out of sight. `dissolve` is true when leaving a level with "Next level".
 */
export async function playLevelChange(
  stage: HTMLElement,
  target: HTMLElement,
  level: Level,
  swap: () => void,
  dissolve: boolean,
): Promise<void> {
  if (busy) return
  busy = true
  // The title layer sits over everything and takes the clicks while it is up.
  const intro = h(
    'div',
    { class: 'level-intro', attrs: { role: 'status', 'aria-live': 'polite' } },
    h('p', { class: 'intro-number', textContent: `Level ${level.id}` }),
    h('p', { class: 'intro-title', textContent: level.title }),
  )
  stage.append(intro)
  try {
    const still = prefersReducedMotion()
    if (dissolve && !still) {
      // Its own sound, as long as the dissolve: `level-dissolve` in assets/sounds.json.
      playSound('level-dissolve')
      await animate(DISSOLVE_MS, (t) => setDissolve(target, easeIn(t)))
    }
    if (!still) setDissolve(target, 1)
    swap()
    intro.classList.add('visible')
    await wait(TITLE_HOLD_MS)
    intro.classList.add('leaving')
    if (still) await wait(REVEAL_MS)
    else await animate(REVEAL_MS, (t) => setDissolve(target, 1 - easeOut(t)))
  } finally {
    setDissolve(target, 0)
    intro.remove()
    busy = false
  }
}
