# Architecture

Four layers. Imports point one way only, and a test (`tests/architecture.test.ts`) enforces it.

```
ui  →  game  →  levels  →  engine
```

| Layer  | Folder                         | Knows about                                                                 | Does not know about                               |
| ------ | ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------- |
| Engine | `src/engine/`                  | AWS behaviour, as pure functions over plain data                            | Levels, drawing, the DOM, time, randomness        |
| Levels | `src/levels/`, `levels/*.json` | The level file format; how to run a level's kites through the engine        | Drawing, the DOM                                  |
| Game   | `src/game/`                    | The current scene and its history; where things are drawn; animation; sound | DOM panels and menus                              |
| UI     | `src/ui/`                      | Screens, panels and cards built from DOM elements                           | AWS rules (it only displays what the engine says) |

## Why it is shaped this way

The engine is the part that has to be right, so it is the part with nothing else in it.
It takes a `Scene` (plain JSON-shaped data) and a `Flow`, and returns a verdict and a
trace. Because it is pure and deterministic, every rule can be tested without a browser,
and a level's reference solution can be proved to work by a unit test.

Everything the player sees after pressing **Fly kites** is read from the trace. The
layers above never work out for themselves whether a security group would allow
something; if the UI needs to know, the engine returns it.

## From a click to a kite's flight

1. **The player changes something** (drags a cloud in, adds a rule on a config card).
   The UI calls a function in `src/game/edits.ts`, which returns a new `Scene`.
   The store (`src/game/store.ts`) keeps the old one for undo.
2. **The store notifies the screen** (`src/ui/gameScreen.ts`), which redraws: the canvas
   through `src/game/skyView.ts` and `render.ts`, the panels through `src/ui/panels.ts`.
   Where each thing is drawn is worked out from the scene by `src/game/layout.ts`;
   positions are never stored in the scene.
3. **The narrator checks its trigger.** Each narration step in a level names what moves
   it on (the player pressed Next, the scene satisfies a predicate, a flight finished).
   The store evaluates that after every change.
4. **The player presses Fly kites.** The store calls `runLevel(level, scene)` in
   `src/levels/run.ts`. That turns each kite in the level into a `Flow`, calls the
   engine's `evaluateFlow` for each, then asks the engine to evaluate the objectives
   and stars. The result is a `LevelRun`.
5. **Playback** (`src/game/playback.ts`) turns each kite's trace into a timed path: the
   kite pauses at every check, and where a check failed, that control's own animation
   plays at that point. Sounds are triggered alongside (`src/game/sound.ts`).
   In a crowd level, `src/game/crowdPlayback.ts` does the same for the crowd: it places
   each tick's kites on the ground and the clock, takes their paths from the engine's
   representative journeys, and blends their sounds into a few voices.
6. **Afterwards**, clicking a Cloudling opens the trace inspector, which lists the same
   trace steps as text.

## Where things live

- **What AWS does**: `src/engine/`. Read `docs/ENGINE.md` alongside it.
- **What a level contains**: `src/levels/schema.ts`. Guide: `docs/LEVEL_AUTHORING.md`.
- **Text the player reads**: level files, `content/explanations.json`,
  `content/fact-cards.json`, and the `explanation` strings the engine writes into traces.
- **Placeholder art**: drawn in code by `src/game/placeholderArt.ts`, at the sizes in
  `assets/manifest.json`.
- **Saved progress**: `src/game/storage.ts` (`localStorage`, every call guarded).
