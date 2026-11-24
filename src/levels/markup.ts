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
