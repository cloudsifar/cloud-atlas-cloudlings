// The narrator follows the sky: a building step the player completed comes back if
// what it built is taken away (ADR 0007). Level 1 is the case that matters: remove
// the load balancer and the guidance for placing and setting it up returns.
//
// No AWS behaviour is modelled here; this is the game's guidance, so there is no
// documentation page to cite.

import { describe, expect, it } from 'vitest'
import { addSecurityGroupRule, removeResource } from '../../src/game/edits'
import { createStore, type Store } from '../../src/game/store'
import { LEVELS } from '../../src/levels'

const firstKite = () => {
  const level = LEVELS.find((candidate) => candidate.id === 1)
  if (!level) throw new Error('Level 1 is missing')
  return level
}

const currentStep = (store: Store) =>
  store.getState().level.narration[store.getState().narrationIndex]?.id

/** Level 1 with the two opening steps read and the reference solution built. */
function builtFirstKite(): Store {
  const level = firstKite()
  const store = createStore(level)
  store.acknowledgeNarration() // welcome
  store.acknowledgeNarration() // the instances
  store.applyEdit(() => structuredClone(level.referenceSolution))
  return store
}

describe('narration rewinds when a completed step is undone', () => {
  it('reaches the "fly" step once everything is built', () => {
    expect(currentStep(builtFirstKite())).toBe('fly')
  })

  it('goes back to placing the load balancer when the load balancer is removed', () => {
    const store = builtFirstKite()
    store.applyEdit((scene) => removeResource(scene, 'alb'))
    expect(currentStep(store)).toBe('place-alb')
  })

  it('then walks forward again through the load balancer set-up as it is redone', () => {
    const store = builtFirstKite()
    store.applyEdit((scene) => removeResource(scene, 'alb'))
    store.undo()
    expect(currentStep(store)).toBe('fly')
  })

  it('goes back to the earliest step that no longer holds', () => {
    const store = builtFirstKite()
    // Removing the gateway also removes the route to it, and the load balancer stays:
    // the narrator returns to the gateway, the first thing now missing.
    store.applyEdit((scene) => removeResource(scene, 'igw'))
    expect(currentStep(store)).toBe('place-igw')
  })

  it('never takes back a step the player acknowledged', () => {
    const store = builtFirstKite()
    store.applyEdit(() => structuredClone(firstKite().initialScene))
    // Back to the first building step, not to the welcome or the instances.
    expect(currentStep(store)).toBe('place-igw')
  })

  it('stays put when a change touches nothing the narrator asked for', () => {
    const store = builtFirstKite()
    store.applyEdit((scene) =>
      addSecurityGroupRule(scene, 'sg-alb', 'inbound', {
        ports: 'http',
        peer: { kind: 'anywhere' },
      }),
    )
    expect(store.getState().undoStack.length).toBe(2)
    expect(currentStep(store)).toBe('fly')
  })
})
