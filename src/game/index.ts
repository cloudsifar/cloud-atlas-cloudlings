// The game layer's public surface, imported by the UI.

export * from './edits'
export * from './store'
export * from './labels'
export { createSkyView, type SkyView, type SkyCallbacks } from './skyView'
export {
  layoutScene,
  centreOf,
  STAGE,
  BAND_OF,
  bandOf,
  GENUS_OF,
  spriteIdOf,
  type DropZone,
  type Rect,
  type Point,
} from './layout'
export { playSound, unlockAudio, applyVolumeSettings, type SoundId } from './sound'
export {
  OBJECTIVE_TICK_MS,
  RESULTS_DELAY_MS,
  objectiveTickTimes,
  objectivesTickedBy,
  resultsDelay,
} from './reveal'
export * from './storage'
export {
  crowdLog,
  fleetSizes,
  membersFailed,
  membersTimedOut,
  playedTicks,
  settledFrom,
  TICK_DURATION,
  type LogEntry,
} from './crowdPlayback'
export { CAPTION_FONT, drawCloud, drawCloudling, drawKite, drawString } from './placeholderArt'
export { loadArt, type ArtId } from './art'
