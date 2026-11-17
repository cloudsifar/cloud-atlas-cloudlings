# Plan

Written at the start of the build (Milestone 0). `PROGRESS.md` records what actually happened.

## Order of work

1. **Milestone 0 — plan.** This file, the engine's core types (`src/engine/model.ts`,
   `src/engine/trace.ts`), a draft level schema (`src/levels/schema.ts`), first ADRs.
2. **Milestone 1 — engine core.** Routing, security groups, network ACLs, IAM and S3, each
   with a test file citing the AWS documentation, plus `docs/ENGINE.md`.
3. **Milestone 2 — vertical slice.** Levels 1–3 as data with reference solutions and
   solvability tests; then the game and UI layers so those levels are playable with
   placeholder art.
4. **Milestones 3–5** follow the brief (Section 15) and are not expected to fit in the
   first session.

## Shape of the code

Four layers, imports pointing one way only: `ui → game → levels → engine`.
`tests/architecture.test.ts` fails if any file imports "upwards".

| Layer | Folder | Job |
| --- | --- | --- |
| Engine | `src/engine/` | The AWS model and evaluator. Pure functions over plain data. No DOM, no randomness, no dependencies |
| Levels | `src/levels/` + `levels/*.json` | Level file type, validator, and `runLevel` (kites → flows → objectives → stars) |
| Game | `src/game/` | Scene store with undo/redo, edits, layout, canvas drawing, playback, sound |
| UI | `src/ui/` | DOM: menus, palette, config cards, narrator, objectives, trace inspector |

## The engine in one paragraph

`evaluateFlow(scene, flow)` returns a verdict and a trace. A scene is plain data
(`Scene` in `model.ts`). The evaluator in `flow.ts` picks the journey (ground → load
balancer → target, instance → S3, ground → S3, ground → private resource) and walks it
as an ordered list of checks; each check calls one rule module and yields one
`TraceStep`. Objectives and stars are computed from the scene and the traces by
`predicates.ts` and `scoring.ts`. Nothing outside the engine re-implements a rule.

## Decisions taken up front

See `docs/adr/`. In short: Canvas 2D with no rendering library; a hand-written level
validator instead of a JSON Schema library; layout positions are derived from the
scene's structure, not stored in it.
