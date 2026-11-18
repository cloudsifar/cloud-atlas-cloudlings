# Cloud Atlas: Cloudlings

A browser game that teaches core AWS architecture at AWS Cloud Practitioner level.
Players build cloud architectures in an illustrated sky; Cloudlings on the ground fly
kites that test whether the architecture works and is secure.

Concept, teaching design and art direction by Simon Farrell. Implementation AI-assisted.

**Status:** Levels 1–5 are playable with placeholder art. See [`PROGRESS.md`](PROGRESS.md)
for exactly what is done, what is next, and what has not been verified yet.

## Run it

```sh
npm install
npm run dev        # play at the address Vite prints
npm test           # engine rules, level solvability, level validation
npm run build      # static site in dist/, relative paths, no server needed
npm run lint       # ESLint + Prettier
```

> Node 20.19+ or 22.12+ (Vite 7 and Vitest 4). All four commands have been run and pass
> (see [`PROGRESS.md`](PROGRESS.md)); the dependency choices are in
> [`docs/adr/0006-dependency-audit.md`](docs/adr/0006-dependency-audit.md). The game is
> built in a sandbox with no access to the npm registry, which uses the fallbacks below;
> see [`docs/adr/0002-tooling-and-offline-fallback.md`](docs/adr/0002-tooling-and-offline-fallback.md).

```sh
npm run offline:test    # same test files on Node's test runner (needs a global `tsx`)
npm run offline:build   # esbuild bundle into dist/ (needs esbuild, or ESBUILD_PATH)
```

The game is a static site: no backend, no accounts, no network calls at runtime.

## Map of the repo

```
src/engine/    The AWS model and evaluator. Pure functions over plain data. Start here.
src/levels/    Level file type, validator, loader, and runLevel (kites → verdicts → stars)
src/game/      Scene store with undo/redo, edits, layout, canvas drawing, playback, sound
src/ui/        DOM: start screen, menu, palette, config cards, narrator, trace inspector
levels/        One JSON file per level
content/       Player-facing text that is not level-specific: explanations, fact cards
assets/        Sprite and sound manifests (placeholders are drawn and synthesised in code)
tests/         engine/ (one file per rule area, each citing AWS docs), levels/, architecture
tools/offline/ Fallback test runner and bundler for machines without Vite and Vitest
docs/          See below
```

Imports point one way only: `ui → game → levels → engine`. `tests/architecture.test.ts`
fails if a file imports "upwards".

## Documents

| File                                                 | What it is for                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| [`PROGRESS.md`](PROGRESS.md)                         | What is done, what is next, known issues                           |
| [`PLAN.md`](PLAN.md)                                 | The plan written before building started                           |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)       | The four layers and how a click becomes a kite's flight            |
| [`docs/ENGINE.md`](docs/ENGINE.md)                   | A guided walk through the engine, rule by rule, with AWS doc links |
| [`docs/SIMPLIFICATIONS.md`](docs/SIMPLIFICATIONS.md) | Every deliberate departure from real AWS                           |
| [`docs/LEVEL_AUTHORING.md`](docs/LEVEL_AUTHORING.md) | How to write a new level                                           |
| [`docs/adr/`](docs/adr)                              | Decision records                                                   |
