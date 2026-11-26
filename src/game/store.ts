// The game's state for one level, and the only ways to change it.
//
// A plain closure rather than a class or a state library: `getState` reads,
// the named methods change, `subscribe` tells the UI to redraw.

import { evaluatePredicate, type Scene } from '../engine'
import { runLevel, type Level, type LevelRun, type NarrationTrigger } from '../levels'

export type GameState = {
  level: Level
  scene: Scene
  undoStack: Scene[]
  redoStack: Scene[]
  /** editing: the player builds. flying: kites are in the air, editing is locked. landed: the run is over. */
  phase: 'editing' | 'flying' | 'landed'
  /** The most recent flight, or null if no kite has flown yet. */
  lastRun: LevelRun | null
  /** False once the scene has changed since `lastRun`: its verdicts no longer describe the sky. */
  lastRunIsCurrent: boolean
  runCount: number
  /** Index into level.narration; equal to its length when the narrator has finished. */
  narrationIndex: number
  /** `runCount` when the current narration step began, so "run-finished" means a new run. */
  narrationRunBaseline: number
  /** Ids whose config card has been opened during the current narration step. */
  openedCards: string[]
  /** How many hint tiers (0–3) are revealed, per objective id. */
  hintTiers: Record<string, number>
}

export type Store = {
  getState(): GameState
  subscribe(listener: () => void): () => void
  /** Applies a scene edit (see edits.ts). Ignored while kites are flying. */
  applyEdit(change: (scene: Scene) => Scene): void
  undo(): void
  redo(): void
  reset(): void
  /** Evaluates the scene and enters the flying phase. Returns the run for playback. */
  startRun(): LevelRun
  /** Called by playback when the last kite has landed, or by Stop. */
  finishRun(): void
  noteCardOpened(subjectId: string): void
  acknowledgeNarration(): void
  revealHint(objectiveId: string): void
}

/** A quiet run of a scene nobody has flown yet, kept per scene (scenes are never edited in place). */
const rehearsals = new WeakMap<Scene, LevelRun>()

/**
 * Whether the narrator's current step is waiting only for a flight: it moves on after a
 * run of the change it asked for, and the sky as it stands would satisfy it. The Fly
 * button points itself out then, so a step that says "make this change" never leaves
 * the player wondering what comes next (Simon, Level 7 step 5, 26 November 2026). The
 * run is the same pure, deterministic one that flying would make.
 */
export function readyToFly(state: GameState): boolean {
  if (state.phase === 'flying' || state.lastRunIsCurrent) return false
  const trigger = state.level.narration[state.narrationIndex]?.advanceWhen
  if (trigger?.kind !== 'run-finished' || trigger.predicate === undefined) return false
  let rehearsal = rehearsals.get(state.scene)
  if (!rehearsal) {
    rehearsal = runLevel(state.level, state.scene)
    rehearsals.set(state.scene, rehearsal)
  }
  return evaluatePredicate(
    state.scene,
    rehearsal.kiteRuns,
    trigger.predicate,
    rehearsal.crowd ?? null,
  )
}

export function createStore(level: Level): Store {
  const initial = (): GameState => ({
    level,
    scene: structuredClone(level.initialScene),
    undoStack: [],
    redoStack: [],
    phase: 'editing',
    lastRun: null,
    lastRunIsCurrent: false,
    runCount: 0,
    narrationIndex: 0,
    narrationRunBaseline: 0,
    openedCards: [],
    hintTiers: {},
  })

  let state = initial()
  const listeners = new Set<() => void>()

  function triggerMet(trigger: NarrationTrigger): boolean {
    switch (trigger.kind) {
      case 'acknowledged':
        return false // only the Next button moves these on
      case 'card-opened':
        return state.openedCards.includes(trigger.subjectId)
      case 'scene':
        return evaluatePredicate(
          state.scene,
          state.lastRun?.kiteRuns ?? [],
          trigger.predicate,
          state.lastRun?.crowd ?? null,
        )
      case 'run-finished':
        return (
          state.phase !== 'flying' &&
          state.runCount > state.narrationRunBaseline &&
          (trigger.predicate === undefined ||
            (state.lastRunIsCurrent &&
              evaluatePredicate(
                state.scene,
                state.lastRun?.kiteRuns ?? [],
                trigger.predicate,
                state.lastRun?.crowd ?? null,
              )))
        )
      case 'level-complete':
        return (
          state.phase !== 'flying' &&
          state.runCount > state.narrationRunBaseline &&
          state.lastRun !== null &&
          state.lastRun.objectives.every((objective) => objective.met)
        )
    }
  }

  function nextNarrationStep(): void {
    state = {
      ...state,
      narrationIndex: state.narrationIndex + 1,
      narrationRunBaseline: state.runCount,
      openedCards: [],
    }
  }

  /**
   * A step the player completed by building something un-completes if that thing is
   * undone: remove Level 1's load balancer and the narrator goes back to placing it, so
   * the guidance for setting it up comes back with it. Only scene steps go back; steps
   * the player acknowledged or saw happen stay done. Levels keep their scene steps
   * cumulative (each still holds in the reference solution), which the level tests check.
   */
  function rewindNarration(next: GameState): GameState {
    for (let index = 0; index < next.narrationIndex; index++) {
      const trigger = level.narration[index]?.advanceWhen
      if (trigger?.kind !== 'scene') continue
      const stillHolds = evaluatePredicate(
        next.scene,
        next.lastRun?.kiteRuns ?? [],
        trigger.predicate,
        next.lastRun?.crowd ?? null,
      )
      if (!stillHolds)
        return {
          ...next,
          narrationIndex: index,
          narrationRunBaseline: next.runCount,
          openedCards: [],
        }
    }
    return next
  }

  /** Every change goes through here: move the narrator back or on as the scene says, then notify. */
  function commit(next: GameState): void {
    state = rewindNarration(next)
    let step = level.narration[state.narrationIndex]
    while (step && triggerMet(step.advanceWhen)) {
      nextNarrationStep()
      step = level.narration[state.narrationIndex]
    }
    for (const listener of listeners) listener()
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    applyEdit(change) {
      if (state.phase === 'flying') return
      const scene = change(state.scene)
      if (JSON.stringify(scene) === JSON.stringify(state.scene)) return
      commit({
        ...state,
        scene,
        undoStack: [...state.undoStack, state.scene],
        redoStack: [],
        phase: 'editing',
        lastRunIsCurrent: false,
      })
    },

    undo() {
      const previous = state.undoStack[state.undoStack.length - 1]
      if (state.phase === 'flying' || !previous) return
      commit({
        ...state,
        scene: previous,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, state.scene],
        phase: 'editing',
        lastRunIsCurrent: false,
      })
    },

    redo() {
      const next = state.redoStack[state.redoStack.length - 1]
      if (state.phase === 'flying' || !next) return
      commit({
        ...state,
        scene: next,
        undoStack: [...state.undoStack, state.scene],
        redoStack: state.redoStack.slice(0, -1),
        phase: 'editing',
        lastRunIsCurrent: false,
      })
    },

    reset() {
      commit(initial())
    },

    startRun() {
      const run = runLevel(level, state.scene)
      commit({ ...state, phase: 'flying', lastRun: run, lastRunIsCurrent: true })
      return run
    },

    finishRun() {
      if (state.phase !== 'flying') return
      commit({ ...state, phase: 'landed', runCount: state.runCount + 1 })
    },

    noteCardOpened(subjectId) {
      if (!state.openedCards.includes(subjectId)) {
        commit({ ...state, openedCards: [...state.openedCards, subjectId] })
      }
    },

    acknowledgeNarration() {
      const step = level.narration[state.narrationIndex]
      if (step?.advanceWhen.kind !== 'acknowledged') return
      nextNarrationStep()
      commit(state)
    },

    revealHint(objectiveId) {
      const tier = Math.min(3, (state.hintTiers[objectiveId] ?? 0) + 1)
      commit({ ...state, hintTiers: { ...state.hintTiers, [objectiveId]: tier } })
    },
  }
}
