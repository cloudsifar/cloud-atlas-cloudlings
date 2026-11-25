// Narration text may link a phrase to a fact card: `[bastion host](card:concept-bastion-host)`.
// The narrator shows the phrase as a link that opens the card; the validator checks
// that every card it names exists.

export type TextSegment = { text: string; factCardId?: string }

const CARD_LINK = /\[([^\]]+)\]\(card:([a-z0-9-]+)\)/g

/** Splits narration text into plain runs and card links, in order. */
export function textSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let last = 0
  for (const match of text.matchAll(CARD_LINK)) {
    const at = match.index
    if (at > last) segments.push({ text: text.slice(last, at) })
    segments.push({ text: match[1] ?? '', factCardId: match[2] ?? '' })
    last = at + match[0].length
  }
  if (last < text.length) segments.push({ text: text.slice(last) })
  return segments
}

/** The text as a reader sees it, with the link markup removed. */
export function plainText(text: string): string {
  return textSegments(text)
    .map((segment) => segment.text)
    .join('')
}

export type LetterSegment = { text: string; bold: boolean }

/**
 * Zone and subnet letters are always bold, wherever they are written (Simon, 25 November
 * 2026): "AZ **a**", "Availability Zone **b**", "Private subnet **A**", "subnets **A** and
 * **B**". Zone letters are lower case, as in eu-central-1a; subnet letters upper case.
 * Only these exact phrases count, so the article in "each zone a cloud" stays as it is.
 */
const PLACE_LETTERS = [
  /\b(?:AZs?|Availability Zones?) ([ab])(?: (?:and|or) ([ab]))?\b/g,
  /\bsubnets? ([AB])(?: (?:and|or) ([AB]))?\b/g,
]

/**
 * Splits text into plain runs and the zone and subnet letters to draw in bold, in order.
 * The interface (`installPlaceLetters`, src/ui/dom.ts) and the sky's captions
 * (src/game/render.ts) both draw from this, so the rule holds everywhere.
 */
export function letterSegments(text: string): LetterSegment[] {
  const letters: number[] = []
  for (const pattern of PLACE_LETTERS) {
    for (const match of text.matchAll(pattern)) {
      const whole = match[0]
      const first = match[1] ?? ''
      // The first letter follows the phrase's first space; a second one ends the match.
      letters.push(match.index + whole.indexOf(` ${first}`) + 1)
      if (match[2]) letters.push(match.index + whole.length - 1)
    }
  }
  if (letters.length === 0) return [{ text, bold: false }]
  letters.sort((first, second) => first - second)
  const segments: LetterSegment[] = []
  let last = 0
  for (const at of letters) {
    if (at > last) segments.push({ text: text.slice(last, at), bold: false })
    segments.push({ text: text.slice(at, at + 1), bold: true })
    last = at + 1
  }
  if (last < text.length) segments.push({ text: text.slice(last), bold: false })
  return segments
}
