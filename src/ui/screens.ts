// The screens outside the game itself: the start screen (which doubles as the
// loading screen) and the main menu with level select, About and Settings.

import {
  applyVolumeSettings,
  CAPTION_FONT,
  drawCloud,
  drawCloudling,
  drawKite,
  drawString,
  loadSavedData,
  playSound,
  prefersReducedMotion,
  resetProgress,
  STAGE,
  updateSettings,
} from '../game'
import { LEVELS, REGION_NAMES, type Level } from '../levels'
import { button, h } from './dom'

/**
 * Placeholder key art, generated in code at the final dimensions. The final
 * art is one image plus a separate transparent title logo; the Start button is
 * always HTML so it stays crisp, accessible and keyboard-operable.
 */
function drawPlaceholderKeyArt(canvas: HTMLCanvasElement): void {
  canvas.width = STAGE.width
  canvas.height = STAGE.height
  const context = canvas.getContext('2d')
  if (!context) return
  const sky = context.createLinearGradient(0, 0, 0, STAGE.height)
  sky.addColorStop(0, '#bcdcf4')
  sky.addColorStop(0.75, '#f3f4e6')
  context.fillStyle = sky
  context.fillRect(0, 0, STAGE.width, STAGE.height)
  context.fillStyle = '#9ccb83'
  context.beginPath()
  context.moveTo(0, 600)
  context.quadraticCurveTo(400, 520, 800, 590)
  context.quadraticCurveTo(1050, 630, 1280, 570)
  context.lineTo(1280, 720)
  context.lineTo(0, 720)
  context.fill()

  const look = { sunlight: 0, burst: 0, opacity: 1 }
  drawCloud(context, 'cumulus', 120, 150, 380, 110, { ...look, tint: ['#d6e8f6'] })
  drawCloud(context, 'altocumulus', 820, 90, 220, 130, { ...look, tint: ['#aecfeb'] })
  drawCloud(context, 'cumulonimbus', 1060, 60, 150, 400, {
    ...look,
    tint: ['#86b4dc', '#aecfeb', '#d6e8f6'],
  })
  drawCloud(context, 'cirrus', 480, 60, 260, 70, { ...look, tint: ['#86b4dc'] })

  context.save()
  context.translate(190, 640)
  context.scale(2.6, 2.6)
  const hand = drawCloudling(context, 0, 0, false, 'idle', '#e8bd3f', 0)
  drawString(context, hand, { x: 62, y: -128 }, 0, 0)
  drawKite(context, 62, -128, false, 'flying', 0, 1.6)
  context.restore()

  context.font = `18px ${CAPTION_FONT}`
  context.fillStyle = 'rgba(60, 56, 72, 0.7)'
  context.fillText('Placeholder key art', 24, STAGE.height - 22)
}

export function mountStartScreen(root: HTMLElement, onStart: () => void): void {
  const art = h('canvas', { class: 'key-art', attrs: { 'aria-hidden': 'true' } })
  drawPlaceholderKeyArt(art)
  const start = button('Start', onStart, 'start', 'primary start-button')
  root.replaceChildren(
    art,
    h(
      'div',
      { class: 'start-overlay' },
      h('h1', { class: 'title-logo' }, 'Cloud Atlas', h('span', { textContent: 'Cloudlings' })),
      h('p', {
        class: 'tagline',
        textContent: 'Build a cloud architecture in the sky. Fly kites to test it.',
      }),
      start,
    ),
  )
  start.focus()
}

export type MenuActions = {
  play(level: Level, guidedRun: boolean): void
  /** Set when the menu was opened from a level: carries on exactly where the player was. */
  resume: { label: string; run(): void } | null
}

export function mountMenu(root: HTMLElement, actions: MenuActions): void {
  const saved = loadSavedData()
  const page = h('div', { class: 'menu' })

  const levelCards = LEVELS.map((level) => {
    const best = saved.bestStars[String(level.id)]
    return h(
      'button',
      {
        type: 'button',
        class: 'level-card',
        onclick: () => actions.play(level, false),
        attrs: { 'data-focus-key': `level-${level.id}` },
      },
      h('span', { class: 'level-number', textContent: String(level.id) }),
      h('strong', { textContent: level.title }),
      h('span', {
        class: 'level-region',
        textContent: `${REGION_NAMES[level.region]} · ${level.region}`,
      }),
      h('span', { class: 'level-concept', textContent: level.concept }),
      h('span', {
        class: 'level-progress',
        textContent:
          best === undefined
            ? 'Not completed yet'
            : `✓ Completed · ${'★'.repeat(best)}${'☆'.repeat(3 - best)}`,
      }),
    )
  })

  const settings = saved.settings
  const slider = (label: string, value: number, onInput: (value: number) => void) => {
    const input = h('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(value),
    })
    input.oninput = () => {
      onInput(Number(input.value))
      applyVolumeSettings()
    }
    return h('label', { class: 'field' }, h('span', { textContent: label }), input)
  }
  const checkbox = (label: string, checked: boolean, onChange: (checked: boolean) => void) => {
    const input = h('input', { type: 'checkbox', checked })
    input.onchange = () => {
      onChange(input.checked)
      applyVolumeSettings()
    }
    return h('label', { class: 'check' }, input, label)
  }

  page.append(
    h('h1', { class: 'title-logo small' }, 'Cloud Atlas', h('span', { textContent: 'Cloudlings' })),
    h(
      'div',
      { class: 'menu-columns' },
      h(
        'section',
        null,
        h('h2', { textContent: 'Play' }),
        actions.resume
          ? h(
              'div',
              { class: 'resume' },
              button(actions.resume.label, actions.resume.run, 'resume', 'primary'),
              h('p', {
                class: 'note',
                textContent:
                  'Your sky is just as you left it. Choosing a level below starts it afresh.',
              }),
            )
          : null,
        button(
          'Guided Run: start at Level 1',
          () => {
            const first = LEVELS[0]
            if (first) actions.play(first, true)
          },
          'guided',
          actions.resume ? 'quiet' : 'primary',
        ),
        h('h2', { textContent: 'Choose a level' }),
        h('p', { class: 'note', textContent: 'Every level is open from the start.' }),
        h('div', { class: 'level-grid' }, ...levelCards),
        h('p', {
          class: 'note',
          textContent: 'Levels 9–12, Demo Mode and the Field Guide to the Sky are still to come.',
        }),
      ),
      h(
        'section',
        null,
        h('h2', { textContent: 'Settings' }),
        checkbox('Reduced motion', prefersReducedMotion(), (checked) =>
          updateSettings({ reducedMotion: checked }),
        ),
        slider('Music volume', settings.musicVolume, (value) =>
          updateSettings({ musicVolume: value }),
        ),
        checkbox('Mute music', settings.musicMuted, (checked) =>
          updateSettings({ musicMuted: checked }),
        ),
        slider('Effects volume', settings.effectsVolume, (value) => {
          updateSettings({ effectsVolume: value })
          playSound('click')
        }),
        checkbox('Mute effects', settings.effectsMuted, (checked) =>
          updateSettings({ effectsMuted: checked }),
        ),
        button(
          'Reset progress',
          () => {
            resetProgress()
            mountMenu(root, actions)
          },
          'reset-progress',
          'quiet',
        ),
        h('h2', { textContent: 'About' }),
        h('p', {
          textContent:
            'Concept, teaching design and art direction by Simon Farrell. Implementation AI-assisted.',
        }),
        h(
          'p',
          null,
          h('a', {
            href: 'https://github.com/cloudsifar',
            textContent: 'github.com/cloudsifar',
            target: '_blank',
            rel: 'noopener',
          }),
        ),
        h('p', {
          class: 'note',
          textContent:
            'AWS services are deliberately simplified for Cloud Practitioner level. Each cloud\'s "What is this?" card lists what was left out. Art and sound are placeholders. Titles are set in Press Start 2P by CodeMan38, under the SIL Open Font License.',
        }),
      ),
    ),
  )
  root.replaceChildren(page)
  // Resuming is the likeliest wish when the menu was opened from a level.
  page.querySelector<HTMLButtonElement>('[data-focus-key="resume"]')?.focus()
}
