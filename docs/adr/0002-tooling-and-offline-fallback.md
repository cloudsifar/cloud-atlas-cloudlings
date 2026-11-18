# 0002 — Vite and Vitest, with an offline fallback

**Context.** The brief requires Vite, Vitest, ESLint and Prettier. The first build
session ran in a sandbox with no access to the npm registry. TypeScript, tsx, esbuild
and Prettier were present; Vite, Vitest and typescript-eslint were not and could not be
installed.

**Decision.** The project is configured for Vite and Vitest exactly as the brief asks
(`package.json`, `vite.config.ts`, `eslint.config.js`). Tests are written against
Vitest's API. So that everything could still be run and verified in the sandbox, two
small fallbacks live in `tools/offline/`:

- `npm run offline:test` runs the same test files on Node's built-in test runner, with
  the import `vitest` mapped to `tools/offline/vitest-shim.ts` (a ~90-line stand-in for
  `describe`, `it` and the handful of `expect` matchers the suite uses).
- `npm run offline:build` bundles the game with esbuild into `dist/`.

**Consequences.**

- **Not yet verified:** `npm install`, `npm test` (real Vitest), `npm run build` (real
  Vite) and `npm run lint` (ESLint) have never been run. Version ranges in
  `package.json` are best guesses and there is no `package-lock.json`. The first job on
  a machine with network access is to run those four commands and fix whatever they report.
  _Update:_ the first install showed the guesses were stale (Vitest 3 and ESLint 9 when
  Vitest 4 and ESLint 10 were current) and pulled in vulnerable packages. ADR 0006 records
  the fix and the lockfile.
- Tests may only use matchers that the shim implements, or the shim must grow. Once
  Vitest is confirmed working, `tools/offline/` can be deleted.
  _Update:_ Vitest 4 now runs the whole suite (ADR 0006), and it is the authority: a
  test counts as passing when `npm test` passes. `tools/offline/` is kept because the
  cloud sandbox where the game is being built still cannot reach the npm registry, and
  the runner is how tests are run there between real runs. Delete it once that sandbox
  can install packages, or once a CI job runs `npm test` on every push.
- `@types/node` is a dev dependency only because tests read files from disk.
