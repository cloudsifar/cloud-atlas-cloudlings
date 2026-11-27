// Loads the level files that ship with the game.
//
// To add a level: drop its JSON file in levels/, import it here, and add it to
// the list. Every file is validated on load, so a malformed level fails at once
// with a message naming the field, rather than misbehaving in play.

import level01 from '../../levels/01-first-kite.json'
import level02 from '../../levels/02-into-the-middle.json'
import level03 from '../../levels/03-the-rain-store.json'
import level04 from '../../levels/04-skyway.json'
import level05 from '../../levels/05-crowd-day.json'
import level06 from '../../levels/06-storm-front.json'
import level07 from '../../levels/07-the-wrong-kite.json'
import level08 from '../../levels/08-under-lock.json'
import level09 from '../../levels/09-no-keys-at-the-door.json'
import factCards from '../../content/fact-cards.json'
import type { Level } from './schema'
import { validateLevel } from './validate'

export type FactCard = {
  title: string
  body: string
  /** Optional short points shown as a list under the body, e.g. the CIDR sizes. */
  points?: string[]
  simplifications: string[]
  atlasPage: string
}

export const FACT_CARDS: Record<string, FactCard> = factCards

export function parseLevel(json: unknown): Level {
  const errors = validateLevel(json, Object.keys(FACT_CARDS))
  if (errors.length > 0) {
    throw new Error(`Invalid level file:\n- ${errors.join('\n- ')}`)
  }
  // validateLevel has just established that the value has the Level shape.
  return json as Level
}

export const LEVELS: Level[] = [
  level01,
  level02,
  level03,
  level04,
  level05,
  level06,
  level07,
  level08,
  level09,
].map(parseLevel)
