// The game screen: the sky in the middle, panels around it. This file wires
// the store, the sky view and the panels together and redraws the panels
// whenever the game state or the screen's own state (which card is open) changes.

import type { Resource } from '../engine'
import {
  centreOf,
  createSkyView,
  createStore,
  layoutScene,
  placeFromPalette,
  playSound,
  recordLevelResult,
  removeResource,
  type GameState,
  type Snap,
} from '../game'
import { REGION_NAMES, type Level, type PaletteEntry } from '../levels'
import { renderConfigCard, type CardSubject } from './configCards'
import { button, h, redraw } from './dom'
import {
  EXPLANATIONS,
  renderFactCard,
  renderNarrator,
  renderObjectives,
  renderPalette,
  renderResults,
  renderTraceInspector,
} from './panels'

export type GameNavigation = {
  toMenu(): void
  /** Null on the last level. */
  toNextLevel: (() => void) | null
}

/** Mounts the game for one level into `root`. Returns a function that tears it down. */
export function mountGameScreen(
  root: HTMLElement,
  level: Level,
  navigation: GameNavigation,
): () => void {
  const store = createStore(level)

  // What this screen itself remembers (the game state lives in the store).
  let openCard: CardSubject | null = null
  let selectedKiteId: string | null = null
  let factCardId: string | null = null
  let explanation: { resourceId: string; text: string } | null = null
  let message: string | null = null
  let messageTimer = 0
  let resultsOpen = false
  let previousPhase: GameState['phase'] = 'editing'

  const canvas = h('canvas', {
    class: 'sky',
    attrs: {
      'aria-label': 'The sky: your VPC, its clouds, and the Cloudlings on the ground',
      role: 'img',
    },
  })
  const topBar = h('header', { class: 'top-bar' })
  const palette = h('aside', { class: 'palette', attrs: { 'aria-label': 'Clouds you can add' } })
  const sidePanel = h('aside', { class: 'side-panel', attrs: { 'aria-label': 'Objectives' } })
  const narrator = h('section', { class: 'narrator', attrs: { 'aria-label': 'Narrator' } })
  const cardLayer = h('div', { class: 'card-layer' })
  root.replaceChildren(canvas, topBar, palette, sidePanel, narrator, cardLayer)

  function showMessage(text: string): void {
    message = text
    window.clearTimeout(messageTimer)
    messageTimer = window.setTimeout(() => {
      message = null
      draw()
    }, 4500)
    draw()
  }

  function explainPlacement(resource: Resource): void {
    explanation = { resourceId: resource.id, text: EXPLANATIONS[resource.kind]?.placement ?? '' }
    draw()
  }

  function place(entry: PaletteEntry, snap: Snap): void {
    store.applyEdit((scene) => placeFromPalette(scene, entry, snap.subnetId))
    playSound(snap.drifted ? 'drift-back' : 'placed')
    // Every placement explains why the cloud belongs in its band.
    explainPlacement(entry.resource)
  }

  const sky = createSkyView(canvas, store, {
    onSelectResource(id) {
      selectedKiteId = null
      openCard = { kind: 'resource', id }
      store.noteCardOpened(id)
      playSound('card-open')
      draw()
    },
    onSelectSubnet(id) {
      selectedKiteId = null
      openCard = { kind: 'subnet', id }
      store.noteCardOpened(id)
      playSound('card-open')
      draw()
    },
    onSelectKite(id) {
      openCard = null
      selectedKiteId = id
      if (!store.getState().lastRun)
        showMessage("Fly the kites first, then click a Cloudling to see its kite's journey.")
      else playSound('card-open')
      draw()
    },
    onSelectNothing() {
      openCard = null
      selectedKiteId = null
      draw()
    },
    onPlaced: place,
    onDriftedBack: explainPlacement,
    onMessage: showMessage,
  })

  function fly(): void {
    openCard = null
    selectedKiteId = null
    explanation = null
    store.startRun()
    sky.play()
  }

  function draw(): void {
    const state = store.getState()
    const step = state.level.narration[state.narrationIndex]
    const highlight = step?.highlight ?? null
    const flying = state.phase === 'flying'

    sky.setHighlight(
      highlight?.startsWith('resource:') || highlight?.startsWith('subnet:') ? highlight : null,
    )
    sky.setSelectedKite(selectedKiteId)

    redraw(
      topBar,
      h(
        'div',
        { class: 'level-title' },
        h('strong', { textContent: `Level ${level.id} · ${level.title}` }),
        h('span', { textContent: `${REGION_NAMES[level.region]} · ${level.region}` }),
      ),
      h(
        'div',
        { class: 'button-row' },
        flying
          ? button('Stop', () => store.finishRun(), 'fly', 'primary')
          : button(
              'Fly kites',
              fly,
              'fly',
              `primary${highlight === 'button:fly' ? ' pointed-at' : ''}`,
            ),
        button('Undo', () => store.undo(), 'undo', 'quiet', flying || state.undoStack.length === 0),
        button('Redo', () => store.redo(), 'redo', 'quiet', flying || state.redoStack.length === 0),
        button(
          'Reset level',
          () => {
            openCard = null
            selectedKiteId = null
            explanation = null
            store.reset()
          },
          'reset',
          'quiet',
          flying,
        ),
        button('Menu', navigation.toMenu, 'menu', 'quiet'),
      ),
    )

    redraw(
      palette,
      ...renderPalette(
        state,
        highlight,
        (entry, event) => sky.beginPaletteDrag(entry, event),
        (entry) => {
          // Click or Enter: place in the default spot (first valid subnet for subnet-bound clouds).
          if (state.scene.resources.some((resource) => resource.id === entry.resource.id)) return
          place(entry, { drifted: false })
        },
      ),
    )
    redraw(
      sidePanel,
      ...renderObjectives(state, (objectiveId) => {
        playSound('hint')
        store.revealHint(objectiveId)
      }),
    )
    redraw(
      narrator,
      ...renderNarrator(state, () => {
        playSound('click')
        store.acknowledgeNarration()
      }),
    )

    // --- floating layer: one card at a time, plus small boxes -----------------
    const layout = layoutScene(state.scene)
    const floating: (HTMLElement | null)[] = []

    const kiteRun =
      selectedKiteId && state.lastRun && state.lastRunIsCurrent && !flying
        ? state.lastRun.kiteRuns.find((candidate) => candidate.kite.id === selectedKiteId)
        : undefined
    let card: HTMLElement | null = null
    let cardAnchorX = 640
    if (kiteRun) {
      card = renderTraceInspector(kiteRun, state.scene, () => {
        selectedKiteId = null
        draw()
      })
      cardAnchorX = 0 // the trace card always sits on the right, clear of the Cloudlings
    } else if (openCard && !flying) {
      card = renderConfigCard(openCard, state, {
        edit: (change) => store.applyEdit(change),
        close: () => {
          openCard = null
          draw()
        },
        openFactCard: (id) => {
          factCardId = id
          playSound('card-open')
          draw()
        },
        remove: (resourceId) => {
          openCard = null
          explanation = null
          store.applyEdit((scene) => removeResource(scene, resourceId))
        },
      })
      const rect =
        openCard.kind === 'resource' ? layout.clouds[openCard.id] : layout.subnets[openCard.id]
      if (rect) cardAnchorX = centreOf(rect).x
    }
    if (card) {
      // Open the card on the opposite side from the thing it describes, so both stay visible.
      card.classList.add(cardAnchorX < 640 ? 'on-right' : 'on-left')
      floating.push(card)
    }

    const explained = explanation ? layout.clouds[explanation.resourceId] : undefined
    if (explanation && explained && !flying) {
      const box = h(
        'div',
        { class: 'explanation', attrs: { role: 'status' } },
        h('p', { textContent: explanation.text }),
        h('button', {
          type: 'button',
          class: 'close',
          textContent: '×',
          onclick: () => {
            explanation = null
            draw()
          },
          attrs: { 'aria-label': 'Close explanation', 'data-focus-key': 'explanation-close' },
        }),
      )
      box.style.left = `${Math.min(Math.max(explained.x + explained.width / 2 - 130, 204), 816)}px`
      box.style.top = `${Math.max(explained.y - 74, 50)}px`
      floating.push(box)
    }
    if (message)
      floating.push(h('div', { class: 'toast', textContent: message, attrs: { role: 'status' } }))

    if (resultsOpen) {
      floating.push(
        renderResults(state, {
          keepBuilding: () => {
            resultsOpen = false
            draw()
          },
          nextLevel: navigation.toNextLevel,
          toMenu: navigation.toMenu,
        }),
      )
    }
    if (factCardId)
      floating.push(
        renderFactCard(factCardId, () => {
          factCardId = null
          draw()
        }),
      )
    redraw(cardLayer, ...floating)
  }

  const unsubscribe = store.subscribe(() => {
    const state = store.getState()
    // The moment the kites land: tick objectives, and celebrate if the level is complete.
    if (previousPhase === 'flying' && state.phase === 'landed' && state.lastRun) {
      const metCount = state.lastRun.objectives.filter((objective) => objective.met).length
      if (metCount > 0) playSound('objective-ticked')
      if (state.lastRun.stars.works) {
        recordLevelResult(level.id, state.lastRun.starCount)
        playSound('level-complete')
        // Let a guided level's closing narration finish before the results card covers it.
        resultsOpen = true
      }
    }
    previousPhase = state.phase
    draw()
  })

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (factCardId) factCardId = null
    else if (resultsOpen) resultsOpen = false
    else if (openCard || selectedKiteId) {
      openCard = null
      selectedKiteId = null
    } else explanation = null
    draw()
  }
  window.addEventListener('keydown', onKeyDown)

  draw()
  return () => {
    unsubscribe()
    window.removeEventListener('keydown', onKeyDown)
    window.clearTimeout(messageTimer)
    sky.destroy()
  }
}
