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
        return evaluatePredicate(state.scene, state.lastRun?.kiteRuns ?? [], trigger.predicate)
      case 'run-finished':
        return state.phase !== 'flying' && state.runCount > state.narrationRunBaseline
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

  /** Every change goes through here: move the narrator on if its trigger is met, then notify. */
  function commit(next: GameState): void {
    state = next
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
