// The narrator follows the sky: a building step the player completed comes back if
// what it built is taken away (ADR 0007). Level 1 is the case that matters: remove
// the load balancer and the guidance for placing and setting it up returns.
//
// No AWS behaviour is modelled here; this is the game's guidance, so there is no
// documentation page to cite.

import { describe, expect, it } from 'vitest'
import {
  addNetworkAclRule,
  addSecurityGroupRule,
  removeResource,
  setSubnetNetworkAcl,
} from '../../src/game/edits'
import { createStore, readyToFly, type Store } from '../../src/game/store'
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

describe('the Fly button points itself out when a step waits only for a flight', () => {
  // Level 7 step 5 asks for an outbound rule and moves on after a run that answers every
  // visitor. Once the rule is in, nothing else on screen says what comes next.
  const wrongKite = () => {
    const level = LEVELS.find((candidate) => candidate.slug === 'the-wrong-kite')
    if (!level) throw new Error('Level 7 is missing')
    return level
  }
  const flyAndLand = (store: Store) => {
    store.startRun()
    store.finishRun()
  }
  /** Level 7 at step 5: edge-acl on both public subnets, HTTPS allowed in, flown. */
  function atStateless(): Store {
    const store = createStore(wrongKite())
    flyAndLand(store) // brief
    store.acknowledgeNarration() // what happened
    store.applyEdit((scene) => setSubnetNetworkAcl(scene, 'public-a', 'edge-acl'))
    store.applyEdit((scene) => setSubnetNetworkAcl(scene, 'public-b', 'edge-acl'))
    flyAndLand(store) // associate
    store.applyEdit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'inbound', {
        number: 100,
        action: 'allow',
        ports: 'https',
        peer: { kind: 'anywhere' },
      }),
    )
    flyAndLand(store) // allow HTTPS
    return store
  }
  const allowReplies = (store: Store) =>
    store.applyEdit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'outbound', {
        number: 100,
        action: 'allow',
        ports: 'ephemeral',
        peer: { kind: 'anywhere' },
      }),
    )

  it('reaches the stateless step', () => {
    expect(currentStep(atStateless())).toBe('stateless')
  })

  it('does not point before the change that the step asks for', () => {
    const store = atStateless()
    expect(readyToFly(store.getState())).toBe(false)
    // A change that leaves the replies dropped does not count either.
    store.applyEdit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'outbound', {
        number: 150,
        action: 'allow',
        ports: 'https',
        peer: { kind: 'anywhere' },
      }),
    )
    expect(store.getState().lastRunIsCurrent).toBe(false)
    expect(readyToFly(store.getState())).toBe(false)
  })

  it('points once the change is made and not yet flown', () => {
    const store = atStateless()
    allowReplies(store)
    expect(currentStep(store)).toBe('stateless')
    expect(readyToFly(store.getState())).toBe(true)
  })

  it('stops pointing once the kites have flown and the narrator has moved on', () => {
    const store = atStateless()
    allowReplies(store)
    flyAndLand(store)
    expect(currentStep(store)).toBe('deny-range')
    expect(readyToFly(store.getState())).toBe(false)
  })
})
