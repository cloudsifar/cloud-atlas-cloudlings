// Runs the Vitest test files on Node's built-in test runner, with "vitest"
// mapped to tools/offline/vitest-shim.ts. Needs a global `tsx`. See ADR 0002.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const findTests = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? findTests(join(dir, entry.name))
      : entry.name.endsWith('.test.ts')
        ? [join(dir, entry.name)]
        : [],
  )

const result = spawnSync(
  'tsx',
  [
    '--tsconfig',
    'tools/offline/tsconfig.json',
    '--test',
    '--test-reporter=spec',
    ...findTests('tests'),
  ],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)
