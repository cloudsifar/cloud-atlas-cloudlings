// Entry point: fits the 1280×720 stage to the window and moves between screens.

import './ui/styles.css'
import { STAGE, unlockAudio } from './game'
import { LEVELS, type Level } from './levels'
import { mountGameScreen } from './ui/gameScreen'
import { h } from './ui/dom'
import { mountMenu, mountStartScreen } from './ui/screens'

const app = document.getElementById('app')
if (!app) throw new Error('index.html is missing #app')

const stage = h('div', { class: 'stage' })
app.append(stage)

/** Desktop first: the stage is designed at 1280×720 and scaled to fit, never cropped. */
function fitStage(): void {
  const scale = Math.min(window.innerWidth / STAGE.width, window.innerHeight / STAGE.height)
  stage.style.transform = `translate(-50%, -50%) scale(${scale})`
}
window.addEventListener('resize', fitStage)
fitStage()

let tearDownGame: (() => void) | null = null

function leaveGame(): void {
  tearDownGame?.()
  tearDownGame = null
}

function showMenu(): void {
  leaveGame()
  stage.className = 'stage on-menu'
  mountMenu(stage, { play: showLevel })
}

function showLevel(level: Level, guidedRun: boolean): void {
  leaveGame()
  stage.className = 'stage in-game'
  const next = LEVELS.find((candidate) => candidate.id === level.id + 1)
  tearDownGame = mountGameScreen(stage, level, {
    toMenu: showMenu,
    toNextLevel: next ? () => showLevel(next, guidedRun) : null,
  })
}

function showStart(): void {
  stage.className = 'stage on-start'
  mountStartScreen(stage, () => {
    // The player's first click: audio may begin from here on.
    unlockAudio()
    if (window.innerWidth < 768) {
      // Phones are meant to get Demo Mode, which is not built yet.
      stage.replaceChildren(
        h(
          'div',
          { class: 'menu' },
          h(
            'h1',
            { class: 'title-logo small' },
            'Cloud Atlas',
            h('span', { textContent: 'Cloudlings' }),
          ),
          h('p', {
            textContent:
              'The editor needs a larger screen. A watch-only Demo Mode for phones is planned; for now, please open the game on a tablet or computer.',
          }),
        ),
      )
      return
    }
    showMenu()
  })
}

showStart()
