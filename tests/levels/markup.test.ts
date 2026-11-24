// Narration text can link a phrase to a fact card with `[phrase](card:id)`. The narrator
// shows the phrase as a link; everything else is plain text.

import { describe, expect, it } from 'vitest'
import { FACT_CARDS, LEVELS, plainText, textSegments } from '../../src/levels'

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
