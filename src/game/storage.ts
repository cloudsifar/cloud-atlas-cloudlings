// Saved progress and settings. localStorage only, under one versioned key.
// Every read and write is wrapped: if storage is unavailable (private mode,
// blocked cookies, quota) the game works normally and simply forgets on reload.

const STORAGE_KEY = 'cloud-atlas-cloudlings/v1'

export type Settings = {
  /** null = follow the operating system's "reduce motion" setting. */
  reducedMotion: boolean | null
  musicVolume: number
  musicMuted: boolean
  effectsVolume: number
  effectsMuted: boolean
}

export type SavedData = {
  /** Best star count per completed level id. */
  bestStars: Record<string, number>
  settings: Settings
}

const DEFAULTS: SavedData = {
  bestStars: {},
  settings: {
    reducedMotion: null,
    musicVolume: 0.3,
    musicMuted: false,
    effectsVolume: 0.6,
    effectsMuted: false,
  },
}

let cache: SavedData | null = null

export function loadSavedData(): SavedData {
  if (cache) return cache
  let stored: Partial<SavedData> = {}
  try {
    const text = window.localStorage.getItem(STORAGE_KEY)
    if (text) stored = JSON.parse(text) as Partial<SavedData>
  } catch {
    // Unavailable or corrupt: fall back to defaults.
  }
  cache = {
    bestStars: { ...stored.bestStars },
    settings: { ...DEFAULTS.settings, ...stored.settings },
  }
  return cache
}

function save(data: SavedData): void {
  cache = data
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // Unavailable: keep the in-memory copy for this visit.
  }
}

export function recordLevelResult(levelId: number, stars: number): void {
  const data = loadSavedData()
  const best = Math.max(stars, data.bestStars[String(levelId)] ?? 0)
  save({ ...data, bestStars: { ...data.bestStars, [String(levelId)]: best } })
}

export function updateSettings(change: Partial<Settings>): void {
  const data = loadSavedData()
  save({ ...data, settings: { ...data.settings, ...change } })
}

export function resetProgress(): void {
  save({ ...loadSavedData(), bestStars: {} })
}

export function prefersReducedMotion(): boolean {
  const chosen = loadSavedData().settings.reducedMotion
  if (chosen !== null) return chosen
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
