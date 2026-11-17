// The layering rule: imports point one way only, ui -> game -> levels -> engine.
// This test reads the source files, so the rule holds even where ESLint is not run.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const LAYERS = ['engine', 'levels', 'game', 'ui'] // lowest first

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('layering', () => {
  for (const [index, layer] of LAYERS.entries()) {
    const higherLayers = LAYERS.slice(index + 1)
    it(`src/${layer} imports nothing from ${higherLayers.join(', ') || 'above (top layer)'}`, () => {
      for (const file of sourceFiles(join('src', layer))) {
        const imports = [...readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(
          (m) => m[1] ?? '',
        )
        for (const specifier of imports) {
          for (const higher of higherLayers) {
            expect(
              specifier.includes(`/${higher}/`) || specifier.endsWith(`/${higher}`),
              `${file} imports ${specifier}`,
            ).toBe(false)
          }
        }
      }
    })
  }

  it('keeps the engine free of the DOM and of randomness', () => {
    for (const file of sourceFiles(join('src', 'engine'))) {
      const text = readFileSync(file, 'utf8')
      expect(/\b(document|window|Math\.random|Date\.now)\b/.test(text), file).toBe(false)
    }
  })
})
