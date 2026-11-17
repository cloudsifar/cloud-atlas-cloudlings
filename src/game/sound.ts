// Sound: two channels (music and effects), each with its own volume and mute.
//
// Nothing plays until `unlockAudio` is called from the player's first click,
// because browsers block audio before an interaction. Every effect is listed in
// assets/sounds.json; until final recordings arrive each one is synthesised from
// the tone recipe in that file. A sound always accompanies a visual cue and is
// never the only signal, so the game works fully on mute.

import manifest from '../../assets/sounds.json'
import { loadSavedData } from './storage'

export type SoundId = keyof typeof manifest.effects

type Tone = {
  wave: string
  from: number
  to: number
  start: number
  duration: number
  gain: number
}

/** No more than this many copies of one sound at once, so a crowd is not a wall of noise. */
const MAX_SIMULTANEOUS = 3
/** The shortest gap between two plays of the same sound. */
const MIN_REPEAT_SECONDS = 0.07

let context: AudioContext | null = null
let effectsGain: GainNode | null = null
let musicGain: GainNode | null = null
const playing = new Map<SoundId, number[]>() // end times of copies still sounding

/** Call from a click handler. Safe to call more than once. */
export function unlockAudio(): void {
  if (context) return
  try {
    context = new AudioContext()
    effectsGain = context.createGain()
    musicGain = context.createGain()
    effectsGain.connect(context.destination)
    musicGain.connect(context.destination)
    applyVolumeSettings()
    // The music placeholder is silence. When a track is supplied (assets/sounds.json),
    // decode it to an AudioBuffer and loop it through `musicGain` for a gapless loop.
  } catch {
    context = null // No Web Audio: the game carries on silently.
  }
}

/** Re-reads the saved volumes; call after the settings change. */
export function applyVolumeSettings(): void {
  const { settings } = loadSavedData()
  if (effectsGain) effectsGain.gain.value = settings.effectsMuted ? 0 : settings.effectsVolume
  if (musicGain) musicGain.gain.value = settings.musicMuted ? 0 : settings.musicVolume
}

function playTone(audio: AudioContext, output: AudioNode, tone: Tone, at: number): void {
  const start = at + tone.start
  const end = start + tone.duration
  const envelope = audio.createGain()
  envelope.gain.setValueAtTime(0, start)
  envelope.gain.linearRampToValueAtTime(tone.gain, start + 0.01)
  envelope.gain.exponentialRampToValueAtTime(0.0001, end)
  envelope.connect(output)

  if (tone.wave === 'noise') {
    // White noise through a sweeping band-pass filter: puffs, whooshes, rain.
    const buffer = audio.createBuffer(
      1,
      Math.ceil(audio.sampleRate * tone.duration),
      audio.sampleRate,
    )
    const samples = buffer.getChannelData(0)
    for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1
    const source = audio.createBufferSource()
    source.buffer = buffer
    const filter = audio.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(tone.from, start)
    filter.frequency.linearRampToValueAtTime(tone.to, end)
    source.connect(filter)
    filter.connect(envelope)
    source.start(start)
  } else {
    const oscillator = audio.createOscillator()
    oscillator.type = tone.wave as OscillatorType
    oscillator.frequency.setValueAtTime(tone.from, start)
    oscillator.frequency.linearRampToValueAtTime(tone.to, end)
    oscillator.connect(envelope)
    oscillator.start(start)
    oscillator.stop(end)
  }
}

/**
 * Plays an effect. `volume` (0 to 1) scales it: a crowd's blended cheer is louder
 * for a bigger crowd, but it is still one cheer.
 */
export function playSound(id: SoundId, volume = 1): void {
  if (!context || !effectsGain) return
  const now = context.currentTime
  const active = (playing.get(id) ?? []).filter((endTime) => endTime > now)
  const lastStart = active.length > 0 ? Math.max(...active) : -Infinity
  const tones: Tone[] = manifest.effects[id].placeholder
  const length = Math.max(...tones.map((tone) => tone.start + tone.duration))
  // Throttle: skip if too many copies are sounding or the last one only just began.
  if (active.length >= MAX_SIMULTANEOUS || now - (lastStart - length) < MIN_REPEAT_SECONDS) return
  for (const tone of tones)
    playTone(context, effectsGain, { ...tone, gain: tone.gain * volume }, now)
  playing.set(id, [...active, now + length])
}
