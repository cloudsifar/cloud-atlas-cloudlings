// Narration text can link a phrase to a fact card with `[phrase](card:id)`. The narrator
// shows the phrase as a link; everything else is plain text.

import { describe, expect, it } from 'vitest'
import { FACT_CARDS, LEVELS, letterSegments, plainText, textSegments } from '../../src/levels'

describe('textSegments', () => {
  it('leaves text without links as one plain run', () => {
    expect(textSegments('Fly the kites.')).toEqual([{ text: 'Fly the kites.' }])
  })

  it('splits a link out of the text around it, in order', () => {
    expect(
      textSegments('Something like a [bastion host](card:concept-bastion-host) helps.'),
    ).toEqual([
      { text: 'Something like a ' },
      { text: 'bastion host', factCardId: 'concept-bastion-host' },
      { text: ' helps.' },
    ])
  })

  it('handles a link at either end and two links in one step', () => {
    expect(textSegments('[ALB](card:alb) then [SG](card:sg)')).toEqual([
      { text: 'ALB', factCardId: 'alb' },
      { text: ' then ' },
      { text: 'SG', factCardId: 'sg' },
    ])
  })

  it('leaves ordinary brackets alone', () => {
    expect(textSegments('Ports [80] and (443) stay as written.')).toEqual([
      { text: 'Ports [80] and (443) stay as written.' },
    ])
  })
})

describe('plainText', () => {
  it('reads as the player sees it, without the markup', () => {
    expect(plainText('Something like a [bastion host](card:concept-bastion-host) helps.')).toBe(
      'Something like a bastion host helps.',
    )
  })
})

describe('shipped narration links', () => {
  it('Level 2 links "bastion host" to its fact card', () => {
    const level = LEVELS.find((candidate) => candidate.id === 2)
    const links = (level?.narration ?? [])
      .flatMap((step) => textSegments(step.text))
      .filter((segment) => segment.factCardId)
    expect(links).toContainEqual({ text: 'bastion host', factCardId: 'concept-bastion-host' })
    expect(FACT_CARDS['concept-bastion-host']).toBeDefined()
  })
})

// Zone and subnet letters are always bold (Simon, 25 November 2026): "AZ a", "Private
// subnet A". The interface and the sky's captions both draw from letterSegments.
describe('letterSegments', () => {
  const bold = (text: string) =>
    letterSegments(text)
      .filter((segment) => segment.bold)
      .map((segment) => segment.text)
  const rejoined = (text: string) =>
    letterSegments(text)
      .map((segment) => segment.text)
      .join('')

  it('picks out the letter of an Availability Zone, short or long', () => {
    expect(letterSegments('When AZ a failed.')).toEqual([
      { text: 'When AZ ', bold: false },
      { text: 'a', bold: true },
      { text: ' failed.', bold: false },
    ])
    expect(bold('is in Availability Zone b, which is down')).toEqual(['b'])
    expect(bold('⚡ Availability Zone a is down')).toEqual(['a'])
  })

  it('picks out the letter of a subnet, and both letters of a pair', () => {
    expect(bold("Private subnet A's address range")).toEqual(['A'])
    expect(bold('tick Public subnet B as well')).toEqual(['B'])
    expect(bold('subnets A and B')).toEqual(['A', 'B'])
    expect(bold('AZs a and b')).toEqual(['a', 'b'])
  })

  it('finds every letter in a sentence, in order, and loses no text', () => {
    const text = 'Private subnet A is in AZ a; Private subnet B is in AZ b.'
    expect(bold(text)).toEqual(['A', 'a', 'B', 'b'])
    expect(rejoined(text)).toBe(text)
  })

  it('leaves other words alone: articles, region names and other letters', () => {
    expect(bold('Give each zone a cloud of its own.')).toEqual([])
    expect(bold('Your region is eu-central-1a.')).toEqual([])
    expect(bold('The subnet. A new one is coming.')).toEqual([])
    expect(bold('AZ c does not exist here, nor does AZ ab.')).toEqual([])
    expect(letterSegments('Fly the kites.')).toEqual([{ text: 'Fly the kites.', bold: false }])
  })
})

describe('zone letters in shipped text', () => {
  // Zones are lower case, as in eu-central-1a, so the bold letter reads the same everywhere.
  const UPPER_ZONE = /\b(?:AZs?|Availability Zones?) [AB]\b/

  it('writes zone letters in lower case in every level and fact card', () => {
    const texts = [...LEVELS.map((level) => JSON.stringify(level)), JSON.stringify(FACT_CARDS)]
    for (const text of texts) expect(text).not.toMatch(UPPER_ZONE)
  })
})
