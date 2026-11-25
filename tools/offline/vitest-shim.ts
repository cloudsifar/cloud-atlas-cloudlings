// A tiny stand-in for the parts of Vitest's API that the test suite uses.
//
// Why this exists: the game was first built in a sandbox with no access to the
// npm registry, so Vitest itself could not be installed. `npm run offline:test`
// maps the import "vitest" to this file and runs the same test files on Node's
// built-in test runner. With a normal `npm install`, use `npm test` (real Vitest)
// and ignore this file. See docs/adr/0002-tooling-and-offline-fallback.md.
import assert from 'node:assert/strict'
export { describe, it, test, beforeEach } from 'node:test'

type Matchers = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toContain(expected: unknown): void
  toContainEqual(expected: unknown): void
  toHaveLength(expected: number): void
  toMatch(expected: RegExp | string): void
  toBeUndefined(): void
  toBeNull(): void
  toBeDefined(): void
  toBeGreaterThan(expected: number): void
  toBeGreaterThanOrEqual(expected: number): void
  toMatchObject(expected: Record<string, unknown>): void
  toThrow(expected?: RegExp | string): void
}

function buildMatchers(actual: unknown, negate: boolean, message?: string): Matchers {
  const check = (pass: boolean, description: string) => {
    if (pass === negate) {
      assert.fail(
        `${message ? message + ': ' : ''}expected ${format(actual)} ${negate ? 'not ' : ''}${description}`,
      )
    }
  }
  return {
    toBe: (expected) => check(Object.is(actual, expected), `to be ${format(expected)}`),
    toEqual: (expected) => check(deepEqual(actual, expected), `to equal ${format(expected)}`),
    toContain: (expected) =>
      check(
        typeof actual === 'string'
          ? actual.includes(String(expected))
          : Array.isArray(actual) && actual.some((item) => deepEqual(item, expected)),
        `to contain ${format(expected)}`,
      ),
    // Vitest's toContainEqual: an array item deeply equal to the expected value.
    toContainEqual: (expected) =>
      check(
        Array.isArray(actual) && actual.some((item) => deepEqual(item, expected)),
        `to contain an item equal to ${format(expected)}`,
      ),
    toHaveLength: (expected) =>
      check((actual as { length: number }).length === expected, `to have length ${expected}`),
    toMatch: (expected) =>
      check(
        typeof expected === 'string'
          ? String(actual).includes(expected)
          : expected.test(String(actual)),
        `to match ${String(expected)}`,
      ),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeGreaterThan: (expected) => check((actual as number) > expected, `to be > ${expected}`),
    toBeGreaterThanOrEqual: (expected) =>
      check((actual as number) >= expected, `to be >= ${expected}`),
    // Vitest's toMatchObject: every property named in `expected` is deeply equal in `actual`.
    toMatchObject: (expected) =>
      check(matchesObject(actual, expected), `to match object ${format(expected)}`),
    toThrow: (expected) => {
      let thrown: unknown
      try {
        ;(actual as () => unknown)()
      } catch (error) {
        thrown = error
      }
      const text = thrown instanceof Error ? thrown.message : String(thrown)
      const matches =
        thrown !== undefined &&
        (expected === undefined ||
          (typeof expected === 'string' ? text.includes(expected) : expected.test(text)))
      check(matches, `to throw ${expected ? String(expected) : ''}`)
    },
  }
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (typeof expected !== 'object' || expected === null) return deepEqual(actual, expected)
  if (typeof actual !== 'object' || actual === null) return false
  return Object.entries(expected).every(([key, value]) =>
    matchesObject((actual as Record<string, unknown>)[key], value),
  )
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    assert.deepStrictEqual(a, b)
    return true
  } catch {
    return false
  }
}

function format(value: unknown): string {
  const text = JSON.stringify(value)
  return text === undefined ? String(value) : text.length > 300 ? text.slice(0, 300) + '…' : text
}

export function expect(actual: unknown, message?: string): Matchers & { not: Matchers } {
  return { ...buildMatchers(actual, false, message), not: buildMatchers(actual, true, message) }
}
