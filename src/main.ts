// Entry point: fits the 1280×720 stage to the window and moves between screens.

import './ui/styles.css'
import { STAGE, unlockAudio } from './game'
import { LEVELS, type Level } from './levels'
import { mountGameScreen, type GameScreen } from './ui/gameScreen'
import { h } from './ui/dom'
import { mountMenu, mountStartScreen } from './ui/screens'
import { playLevelChange } from './ui/transition'

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

// The game and the menu each have a layer. Opening the menu from a level hides the
// level and pauses it rather than throwing it away, so the player can change a setting
// and carry on where they were.
const gameLayer = h('div', { class: 'game-layer' })
const menuLayer = h('div', { class: 'menu-layer' })
let game: { level: Level; screen: GameScreen } | null = null

function useLayers(): void {
  if (gameLayer.parentElement !== stage) stage.replaceChildren(gameLayer, menuLayer)
}

function endGame(): void {
  game?.screen.destroy()
  game = null
  gameLayer.replaceChildren()
}

function showMenu(): void {
  useLayers()
  game?.screen.setActive(false)
  gameLayer.hidden = true
  menuLayer.hidden = false
  stage.className = 'stage on-menu'
  const paused = game
  mountMenu(menuLayer, {
    play: (level, guidedRun) => changeLevel(level, guidedRun, false),
    resume: paused
      ? { label: `Resume Level ${paused.level.id} · ${paused.level.title}`, run: resumeGame }
      : null,
  })
}

function resumeGame(): void {
  if (!game) return
  menuLayer.hidden = true
  menuLayer.replaceChildren()
  gameLayer.hidden = false
  stage.className = 'stage in-game'
  game.screen.setActive(true)
}

function showLevel(level: Level, guidedRun: boolean): void {
  useLayers()
  endGame()
  menuLayer.hidden = true
  menuLayer.replaceChildren()
  gameLayer.hidden = false
  stage.className = 'stage in-game'
  const next = LEVELS.find((candidate) => candidate.id === level.id + 1)
  game = {
    level,
    screen: mountGameScreen(gameLayer, level, {
      toMenu: showMenu,
      toNextLevel: next ? () => changeLevel(next, guidedRun, true) : null,
    }),
  }
}

/**
 * Starts a level with its title card (ADR 0010). From "Next level" the old sky dissolves
 * into pixels first; from the menu the new level starts at the title.
 */
function changeLevel(level: Level, guidedRun: boolean, dissolve: boolean): void {
  useLayers()
  void playLevelChange(stage, gameLayer, level, () => showLevel(level, guidedRun), dissolve)
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
