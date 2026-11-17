// The sky view: owns the canvas, runs the frame loop, and turns pointer input
// into game actions. It draws through render.ts and changes the game only
// through the store and the callbacks it is given, so it knows nothing about
// the DOM panels around it.

import { resourcesOfKind, type Resource, type Scene } from '../engine'
import type { PaletteEntry } from '../levels'
import { canStartConnection, connect, moveToSubnet, validSubnetsFor } from './edits'
import {
  cloudlingPosition,
  handlePosition,
  layoutScene,
  resourceAt,
  snapDrop,
  STAGE,
  subnetAt,
  validDropZones,
  type Point,
  type Snap,
} from './layout'
import { buildScripts, runDuration, soundsBetween, type KiteScript } from './playback'
import { drawSky, type DragView } from './render'
import { playSound } from './sound'
import { prefersReducedMotion } from './storage'
import type { Store } from './store'

export type SkyCallbacks = {
  onSelectResource(id: string): void
  onSelectSubnet(id: string): void
  onSelectKite(id: string): void
  onSelectNothing(): void
  /** A cloud was dropped from the palette. */
  onPlaced(entry: PaletteEntry, snap: Snap): void
  /** A placed cloud was dragged outside its band and drifted back. */
  onDriftedBack(resource: Resource): void
  /** A one-line explanation to show the player (e.g. why a connection was refused). */
  onMessage(text: string): void
}

export type SkyView = {
  /** Called by the palette when the player starts dragging a specimen card. */
  beginPaletteDrag(entry: PaletteEntry, event: PointerEvent): void
  setHighlight(highlight: string | null): void
  setSelectedKite(kiteId: string | null): void
  /** Starts animating the run the store has just begun (call straight after `store.startRun()`). The view calls `store.finishRun()` when the last kite lands. */
  play(): void
  destroy(): void
}

/** How far the pointer must move before a press on a cloud becomes a drag. */
const DRAG_THRESHOLD = 8

type Press =
  | { kind: 'resource'; id: string; at: Point }
  | { kind: 'subnet'; id: string; at: Point }
  | { kind: 'kite'; id: string; at: Point }
  | { kind: 'nothing'; at: Point }

export function createSkyView(
  canvas: HTMLCanvasElement,
  store: Store,
  callbacks: SkyCallbacks,
): SkyView {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is not available')
  canvas.width = STAGE.width
  canvas.height = STAGE.height

  let highlight: string | null = null
  let selectedKiteId: string | null = null
  let drag: DragView | null = null
  /** What a drag in progress will do when the pointer is released. */
  let dragAction:
    | { kind: 'palette'; entry: PaletteEntry }
    | { kind: 'move'; resourceId: string }
    | { kind: 'connect'; fromId: string }
    | null = null
  let press: Press | null = null

  let scripts: KiteScript[] = []
  let scriptsScene: Scene | null = null
  let runStartedAt = 0
  let previousRunTime = 0

  let lastScene = store.getState().scene
  const sunlightStartedAt: Record<string, number> = {}
  let frameRequest = 0
  let now = 0

  const toStage = (event: PointerEvent): Point => {
    const bounds = canvas.getBoundingClientRect()
    return {
      x: ((event.clientX - bounds.left) / bounds.width) * STAGE.width,
      y: ((event.clientY - bounds.top) / bounds.height) * STAGE.height,
    }
  }

  /** Golden sunlight on every cloud whose own settings, or whose security groups, just changed. */
  function noteSceneChange(previous: Scene, next: Scene): void {
    const groupChanged = (id: string) =>
      JSON.stringify(previous.securityGroups.find((group) => group.id === id)) !==
      JSON.stringify(next.securityGroups.find((group) => group.id === id))
    let changed = false
    for (const resource of next.resources) {
      const before = previous.resources.find((candidate) => candidate.id === resource.id)
      const groups = 'securityGroupIds' in resource ? resource.securityGroupIds : []
      if (JSON.stringify(before) !== JSON.stringify(resource) || groups.some(groupChanged)) {
        sunlightStartedAt[resource.id] = now
        changed = true
      }
    }
    if (JSON.stringify(previous.routeTables) !== JSON.stringify(next.routeTables)) {
      // A route change takes effect at the gateway it concerns.
      for (const gateway of [
        ...resourcesOfKind(next, 'internet-gateway'),
        ...resourcesOfKind(next, 'nat-gateway'),
      ]) {
        sunlightStartedAt[gateway.id] = now
      }
      changed = true
    }
    if (changed) playSound('change-applied')
  }

  function frame(timestamp: number): void {
    now = timestamp
    const state = store.getState()
    if (state.scene !== lastScene) {
      noteSceneChange(lastScene, state.scene)
      lastScene = state.scene
    }
    const layout = layoutScene(state.scene)
    const reducedMotion = prefersReducedMotion()

    // Which run, if any, is on show? Only one that still describes the current scene.
    const showRun = state.lastRun !== null && state.lastRunIsCurrent
    if (showRun && state.lastRun && scriptsScene !== state.scene) {
      scripts = buildScripts(state.lastRun, state.scene, layout)
      scriptsScene = state.scene
    }
    if (!showRun) {
      scripts = []
      scriptsScene = null
    }

    let runTime = Infinity // landed: every kite at its final frame
    if (state.phase === 'flying') {
      // With reduced motion there is no flight: after a short beat the result is shown as a static path.
      runTime = reducedMotion
        ? timestamp - runStartedAt > 400
          ? Infinity
          : 0
        : timestamp - runStartedAt
      if (!reducedMotion) {
        for (const sound of soundsBetween(scripts, previousRunTime, runTime)) playSound(sound)
      }
      previousRunTime = runTime
      if (runTime >= runDuration(scripts)) store.finishRun()
    }

    const compromisedIds =
      showRun && state.phase !== 'flying'
        ? (state.lastRun?.kiteRuns ?? [])
            .filter((kiteRun) => kiteRun.result.outcome === 'breach')
            .map((kiteRun) => kiteRun.kite.destinationId)
        : []

    drawSky(context!, {
      level: state.level,
      scene: state.scene,
      layout,
      time: timestamp,
      lockedIds: state.level.lockedIds,
      editable: state.phase !== 'flying',
      scripts,
      runTime,
      compromisedIds,
      sunlightStartedAt,
      highlight,
      selectedKiteId,
      drag,
      reducedMotion,
    })
    frameRequest = requestAnimationFrame(frame)
  }

  // --- pointer input ---------------------------------------------------------

  function kiteAt(point: Point): string | undefined {
    return store.getState().level.population.find((kite) => {
      const feet = cloudlingPosition(kite.groundPosition)
      return Math.abs(point.x - feet.x) <= 20 && point.y >= feet.y - 66 && point.y <= feet.y + 22
    })?.id
  }

  function onPointerDown(event: PointerEvent): void {
    const state = store.getState()
    const point = toStage(event)
    const layout = layoutScene(state.scene)
    const editable = state.phase !== 'flying'
    const locked = (id: string) => state.level.lockedIds.includes(id)

    const kiteId = kiteAt(point)
    if (kiteId) {
      press = { kind: 'kite', id: kiteId, at: point }
      return
    }
    if (editable) {
      // Connector handles sit on top of their clouds, so test them first.
      const handleOwner = state.scene.resources.find((resource) => {
        const rect = layout.clouds[resource.id]
        if (!rect || locked(resource.id) || !canStartConnection(resource.kind)) return false
        const handle = handlePosition(rect)
        return Math.hypot(point.x - handle.x, point.y - handle.y) <= 11
      })
      if (handleOwner) {
        dragAction = { kind: 'connect', fromId: handleOwner.id }
        drag = { kind: 'connect', from: point, to: point }
        canvas.setPointerCapture(event.pointerId)
        return
      }
    }
    const resource = resourceAt(state.scene, layout, point)
    const subnet = subnetAt(state.scene, layout, point)
    press = resource
      ? { kind: 'resource', id: resource.id, at: point }
      : subnet
        ? { kind: 'subnet', id: subnet.id, at: point }
        : { kind: 'nothing', at: point }
    canvas.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: PointerEvent): void {
    const point = toStage(event)
    if (drag?.kind === 'connect') {
      drag = { ...drag, to: point }
      return
    }
    if (drag?.kind === 'place') {
      drag = { ...drag, point }
      return
    }
    // A press on a movable cloud becomes a drag once the pointer has travelled far enough.
    if (
      press?.kind === 'resource' &&
      Math.hypot(point.x - press.at.x, point.y - press.at.y) > DRAG_THRESHOLD
    ) {
      const state = store.getState()
      const pressedId = press.id
      const resource = state.scene.resources.find((candidate) => candidate.id === pressedId)
      const movable =
        resource !== undefined &&
        state.phase !== 'flying' &&
        !state.level.lockedIds.includes(resource.id) &&
        validSubnetsFor(state.scene, resource.kind).length > 0
      if (resource && movable) {
        const layout = layoutScene(state.scene)
        dragAction = { kind: 'move', resourceId: resource.id }
        drag = {
          kind: 'place',
          resourceKind: resource.kind,
          point,
          zones: validDropZones(layout, resource.kind, validSubnetsFor(state.scene, resource.kind)),
        }
        press = null
      }
    }
  }

  function finishDrag(point: Point, overSky: boolean): void {
    const state = store.getState()
    const layout = layoutScene(state.scene)
    const action = dragAction
    drag = null
    dragAction = null
    if (!action) return

    if (action.kind === 'connect') {
      const target = resourceAt(state.scene, layout, point)
      if (!target || target.id === action.fromId) return
      const result = connect(state.scene, action.fromId, target.id)
      if (result.ok) store.applyEdit(() => result.scene)
      else callbacks.onMessage(result.reason)
      return
    }
    if (action.kind === 'palette') {
      if (!overSky) return // let go over the tray: nothing placed
      const kind = action.entry.resource.kind
      callbacks.onPlaced(
        action.entry,
        snapDrop(layout, kind, point, validSubnetsFor(state.scene, kind)),
      )
      return
    }
    const resource = state.scene.resources.find((candidate) => candidate.id === action.resourceId)
    if (!resource) return
    const snap = snapDrop(layout, resource.kind, point, validSubnetsFor(state.scene, resource.kind))
    if (snap.drifted) {
      // Dropped outside its band: the cloud stays where it belongs, and says why.
      playSound('drift-back')
      callbacks.onDriftedBack(resource)
    } else if (snap.subnetId) {
      const subnetId = snap.subnetId
      store.applyEdit((scene) => moveToSubnet(scene, resource.id, subnetId))
    }
  }

  function onPointerUp(event: PointerEvent): void {
    const point = toStage(event)
    if (drag) {
      finishDrag(point, true)
      return
    }
    const pressed = press
    press = null
    if (!pressed) return
    switch (pressed.kind) {
      case 'resource':
        callbacks.onSelectResource(pressed.id)
        break
      case 'subnet':
        callbacks.onSelectSubnet(pressed.id)
        break
      case 'kite':
        callbacks.onSelectKite(pressed.id)
        break
      case 'nothing':
        callbacks.onSelectNothing()
        break
    }
  }

  // A palette drag starts outside the canvas, so it is tracked on the window.
  function onWindowMove(event: PointerEvent): void {
    if (dragAction?.kind === 'palette' && drag?.kind === 'place')
      drag = { ...drag, point: toStage(event) }
  }
  function onWindowUp(event: PointerEvent): void {
    if (dragAction?.kind !== 'palette') return
    const bounds = canvas.getBoundingClientRect()
    const inside =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom
    const point = toStage(event)
    // The palette tray and side panel sit over the canvas; only the open sky counts.
    finishDrag(point, inside && point.x > 196 && point.x < 1084)
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointermove', onWindowMove)
  window.addEventListener('pointerup', onWindowUp)
  frameRequest = requestAnimationFrame(frame)

  return {
    beginPaletteDrag(entry, event) {
      const state = store.getState()
      if (state.phase === 'flying') return
      const kind = entry.resource.kind
      dragAction = { kind: 'palette', entry }
      drag = {
        kind: 'place',
        resourceKind: kind,
        point: toStage(event),
        zones: validDropZones(layoutScene(state.scene), kind, validSubnetsFor(state.scene, kind)),
      }
    },
    setHighlight(next) {
      highlight = next
    },
    setSelectedKite(kiteId) {
      selectedKiteId = kiteId
    },
    play() {
      runStartedAt = now
      previousRunTime = 0
      scriptsScene = null // rebuild the timetable for this run on the next frame
    },
    destroy() {
      cancelAnimationFrame(frameRequest)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointermove', onWindowMove)
      window.removeEventListener('pointerup', onWindowUp)
    },
  }
}
