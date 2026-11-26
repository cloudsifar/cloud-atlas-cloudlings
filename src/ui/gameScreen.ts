// The game screen: the sky in the middle, panels around it. This file wires
// the store, the sky view and the panels together and redraws the panels
// whenever the game state or the screen's own state (which card is open) changes.

import { HTTPS_PORT, type CrowdRecord, type Resource } from '../engine'
import {
  centreOf,
  createSkyView,
  createStore,
  layoutScene,
  placeFromPalette,
  objectiveTickTimes,
  playSound,
  recordLevelResult,
  removeResource,
  resultsDelay,
  type GameState,
} from '../game'
import {
  kiteToFlow,
  REGION_NAMES,
  type Kite,
  type KiteRun,
  type Level,
  type PaletteEntry,
} from '../levels'
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
  type CrowdKiteChoice,
} from './panels'

export type GameNavigation = {
  /** Opens the menu over the level, which stays as it is and can be resumed. */
  toMenu(): void
  /** Null on the last level. */
  toNextLevel: (() => void) | null
}

export type GameScreen = {
  /** Hides or shows the level without losing it: the menu is opened over a paused level. */
  setActive(active: boolean): void
  /** Redraws the panels: a picture has arrived (ADR 0016). The sky redraws every frame anyway. */
  refresh(): void
  destroy(): void
}

/** Mounts the game for one level into `root`. */
export function mountGameScreen(
  root: HTMLElement,
  level: Level,
  navigation: GameNavigation,
): GameScreen {
  const store = createStore(level)

  // What this screen itself remembers (the game state lives in the store).
  let openCard: CardSubject | null = null
  let selectedKiteId: string | null = null
  /** A kite from the crowd whose journey is open, chosen on the weather station. */
  let selectedCrowdKite: CrowdKiteChoice | null = null
  let factCardId: string | null = null
  let explanation: { resourceId: string; text: string } | null = null
  let message: string | null = null
  let messageTimer = 0
  let resultsOpen = false
  let resultsTimer = 0
  /**
   * How many of the last run's objectives have ticked so far: they tick one at a time
   * after landing (ADR 0011). Everything counts as ticked until a run lands.
   */
  let objectivesTicked = Number.POSITIVE_INFINITY
  /** In a crowd level, the minute the flying crowd has reached; null when not flying. */
  let crowdMinute: number | null = null
  let tickTimers: number[] = []
  /** A cloud whose removal waits on the player confirming the level's warning. */
  let pendingRemoval: string | null = null
  /** A control to focus once the cards are redrawn (a redrawn card scrolls back to its top). */
  let focusAfterDraw: string | null = null
  let active = true
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

  function place(entry: PaletteEntry, subnetId: string | undefined): void {
    store.applyEdit((scene) => placeFromPalette(scene, entry, subnetId))
    playSound('placed')
    // Every placement explains why the cloud belongs in its band.
    explainPlacement(entry.resource)
  }

  const nameOf = (kind: Resource['kind']) => EXPLANATIONS[kind]?.label ?? kind

  const sky = createSkyView(canvas, store, {
    onSelectResource(id) {
      selectedKiteId = null
      selectedCrowdKite = null
      openCard = { kind: 'resource', id }
      store.noteCardOpened(id)
      playSound('card-open')
      draw()
    },
    onSelectSubnet(id) {
      selectedKiteId = null
      selectedCrowdKite = null
      openCard = { kind: 'subnet', id }
      store.noteCardOpened(id)
      playSound('card-open')
      draw()
    },
    onSelectKite(id) {
      // The Cloudling says what it wants (the sky view draws the bubble). Once the kites
      // have flown, its kite's journey opens in the trace inspector as well.
      openCard = null
      selectedCrowdKite = null
      selectedKiteId = store.getState().lastRun ? id : null
      if (selectedKiteId) playSound('card-open')
      draw()
    },
    onSelectVpcCidr() {
      factCardId = 'concept-cidr'
      playSound('card-open')
      draw()
    },
    onSelectNothing() {
      openCard = null
      selectedKiteId = null
      selectedCrowdKite = null
      draw()
    },
    onPlaced: place,
    onDropRejected(kind) {
      playSound('drift-back')
      showMessage(
        `That isn't where the ${nameOf(kind)} goes, so it went back to the tray. ${EXPLANATIONS[kind]?.placement ?? ''}`,
      )
    },
    onDriftedBack: explainPlacement,
    onMessage: showMessage,
    onCrowdMinute(minute) {
      crowdMinute = minute
      drawSidePanel(store.getState())
    },
  })

  function fly(): void {
    openCard = null
    selectedKiteId = null
    selectedCrowdKite = null
    explanation = null
    store.startRun()
    sky.play()
  }

  function removeNow(resourceId: string): void {
    openCard = null
    explanation = null
    pendingRemoval = null
    store.applyEdit((scene) => removeResource(scene, resourceId))
  }

  /** The objectives, stars and weather station. Redrawn on its own as the crowd's minutes pass. */
  function drawSidePanel(state: GameState): void {
    redraw(
      sidePanel,
      ...renderObjectives(
        state,
        (objectiveId) => {
          playSound('hint')
          store.revealHint(objectiveId)
        },
        (choice) => {
          openCard = null
          selectedKiteId = null
          selectedCrowdKite = choice
          playSound('card-open')
          draw()
        },
        objectivesTicked,
        crowdMinute,
      ),
    )
  }

  function draw(): void {
    const state = store.getState()
    // A pending removal belongs to the card it was asked on.
    if (pendingRemoval && !(openCard?.kind === 'resource' && openCard.id === pendingRemoval))
      pendingRemoval = null
    const step = state.level.narration[state.narrationIndex]
    const highlights = step?.highlight === undefined ? [] : [step.highlight].flat()
    const highlight =
      highlights.find((item) => item.startsWith('palette:') || item === 'button:fly') ?? null
    const flying = state.phase === 'flying'

    sky.setHighlights(
      highlights.filter((item) => item.startsWith('resource:') || item.startsWith('subnet:')),
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
            selectedCrowdKite = null
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
        (entry, fromKeyboard) => {
          if (state.scene.resources.some((resource) => resource.id === entry.resource.id)) return
          // Enter or Space: the keyboard route places it in its default spot (the first valid
          // subnet for subnet-bound clouds). A mouse click is told to drag instead.
          if (fromKeyboard) place(entry, undefined)
          else
            showMessage(
              `Drag the ${nameOf(entry.resource.kind)} into the sky, and let go when the place it belongs lights up.`,
            )
        },
      ),
    )
    drawSidePanel(state)
    redraw(
      narrator,
      ...renderNarrator(
        state,
        () => {
          playSound('click')
          store.acknowledgeNarration()
        },
        (cardId) => {
          factCardId = cardId
          playSound('card-open')
          draw()
        },
      ),
    )

    // --- floating layer: one card at a time, plus small boxes -----------------
    const layout = layoutScene(state.scene)
    const floating: (HTMLElement | null)[] = []

    const showingRun = state.lastRun !== null && state.lastRunIsCurrent && !flying
    const kiteRun = !showingRun
      ? undefined
      : selectedCrowdKite && state.lastRun?.crowd
        ? crowdKiteRun(level, state.lastRun.crowd, selectedCrowdKite)
        : state.lastRun?.kiteRuns.find((candidate) => candidate.kite.id === selectedKiteId)
    let card: HTMLElement | null = null
    let cardAnchorX = 640
    if (kiteRun) {
      card = renderTraceInspector(kiteRun, state.scene, () => {
        selectedKiteId = null
        selectedCrowdKite = null
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
          // Some clouds carry a warning first (Level 1's load balancer and gateway).
          if (level.removalWarnings?.[resourceId]) {
            pendingRemoval = resourceId
            // Focus the safe choice: it also scrolls the warning into view.
            focusAfterDraw = 'card-remove-keep'
            playSound('hint')
            draw()
            return
          }
          removeNow(resourceId)
        },
        pendingRemoval,
        // The headings the current narrator step points at pulse until it is done.
        pulse: level.narration[state.narrationIndex]?.pulse ?? [],
        confirmRemove: removeNow,
        cancelRemove: () => {
          pendingRemoval = null
          focusAfterDraw = 'card-remove'
          draw()
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
      // Beside the cloud, never on top of it, and never under an open card: to its right
      // if there is room, otherwise to its left, otherwise just below it.
      const boxWidth = 260
      const gap = 14
      const cardOnRight = card?.classList.contains('on-right') ?? false
      const cardOnLeft = card?.classList.contains('on-left') ?? false
      const free = { from: cardOnLeft ? 524 : 204, to: cardOnRight ? 756 : 1076 }
      const rightOfCloud = explained.x + explained.width + gap
      const leftOfCloud = explained.x - boxWidth - gap
      let left = rightOfCloud
      let top = Math.max(explained.y - 6, 50)
      if (rightOfCloud + boxWidth > free.to) {
        if (leftOfCloud >= free.from) left = leftOfCloud
        else {
          const centred = centreOf(explained).x - boxWidth / 2
          left = Math.min(Math.max(centred, free.from), free.to - boxWidth)
          top = explained.y + explained.height + gap
        }
      }
      box.style.left = `${Math.max(left, 204)}px`
      box.style.top = `${top}px`
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
    if (focusAfterDraw) {
      cardLayer.querySelector<HTMLElement>(`[data-focus-key="${focusAfterDraw}"]`)?.focus()
      focusAfterDraw = null
    }
  }

  const clearTickTimers = (): void => {
    for (const timer of tickTimers) window.clearTimeout(timer)
    tickTimers = []
  }

  const unsubscribe = store.subscribe(() => {
    const state = store.getState()
    // The moment the kites land: tick the objectives one at a time, a second apart and in
    // the level's order, then celebrate if the level is complete (ADR 0011).
    if (previousPhase === 'flying' && state.phase === 'landed' && state.lastRun) {
      const run = state.lastRun
      const stillShowing = () =>
        store.getState().lastRun === run && store.getState().phase === 'landed'
      clearTickTimers()
      objectivesTicked = 0
      objectiveTickTimes(level.objectives.length).forEach((at, index) => {
        const objective = level.objectives[index]
        const tick = () => {
          if (!stillShowing()) return
          objectivesTicked = index + 1
          const met = run.objectives.find((result) => result.id === objective?.id)?.met ?? false
          if (met && active) playSound('objective-ticked')
          draw()
        }
        // The first objective ticks as the last ending finishes, which is the landing itself;
        // the redraw at the end of this handler shows it.
        if (at === 0) {
          objectivesTicked = 1
          if (run.objectives.find((result) => result.id === objective?.id)?.met && active)
            playSound('objective-ticked')
        } else tickTimers.push(window.setTimeout(tick, at))
      })
      if (run.stars.works) {
        recordLevelResult(level.id, run.starCount)
        // The results card waits for the endings to play out (rain and data reaching the
        // Cloudlings, ADR 0009) and for every objective to tick (ADR 0011).
        window.clearTimeout(resultsTimer)
        resultsTimer = window.setTimeout(() => {
          if (!stillShowing()) return
          if (active) playSound('level-complete')
          resultsOpen = true
          draw()
        }, resultsDelay(level.objectives.length))
      }
    }
    if (state.phase !== 'landed') {
      window.clearTimeout(resultsTimer)
      clearTickTimers()
      objectivesTicked = Number.POSITIVE_INFINITY
    }
    previousPhase = state.phase
    draw()
  })

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !active) return
    if (factCardId) factCardId = null
    else if (resultsOpen) resultsOpen = false
    else if (openCard || selectedKiteId) {
      openCard = null
      selectedKiteId = null
      selectedCrowdKite = null
    } else explanation = null
    draw()
  }
  window.addEventListener('keydown', onKeyDown)

  draw()
  return {
    setActive(next) {
      active = next
      sky.setActive(next)
    },
    refresh() {
      draw()
    },
    destroy() {
      unsubscribe()
      window.removeEventListener('keydown', onKeyDown)
      window.clearTimeout(messageTimer)
      window.clearTimeout(resultsTimer)
      clearTickTimers()
      sky.destroy()
    },
  }
}

/**
 * One kite from the crowd, ready for the trace inspector. The journey is the engine's
 * own (crowd.ts keeps one for a served kite and one for a timed-out kite on each
 * tick); this only gives it a Cloudling to belong to.
 */
function crowdKiteRun(
  level: Level,
  crowd: CrowdRecord,
  choice: CrowdKiteChoice,
): KiteRun | undefined {
  const tick = crowd.ticks[choice.tick]
  const result =
    choice.fate === 'timed-out'
      ? tick?.timedOut
      : choice.fate === 'stopped'
        ? tick?.stopped
        : tick?.served
  if (!tick || !result || !level.crowd) return undefined
  const kite: Kite = {
    id: 'crowd',
    kind: 'friendly',
    groundPosition: 0,
    ip: level.crowd.ip,
    destinationId: level.crowd.loadBalancerId,
    port: HTTPS_PORT,
    payload: 'clean',
    label: `one of ${tick.demand} kites in the crowd, minute ${tick.tick}`,
    says: level.population[0]?.says ?? 'I want to visit the website!',
    ...(level.crowd.backendCall ? { backendCall: level.crowd.backendCall } : {}),
  }
  return { kite, flow: kiteToFlow(kite, tick.tick), result }
}
