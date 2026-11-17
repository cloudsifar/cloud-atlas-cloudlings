// Every shipped level must be valid, unsolved at the start, and solvable.

import { describe, expect, it } from 'vitest'
import { FACT_CARDS, LEVELS, runLevel, validateLevel } from '../../src/levels'

describe('shipped levels', () => {
  it('has levels numbered from 1 with no gaps', () => {
    expect(LEVELS.map((level) => level.id)).toEqual(LEVELS.map((_, index) => index + 1))
  })

  for (const level of LEVELS) {
    describe(`Level ${level.id}: ${level.title}`, () => {
      it('validates against the schema', () => {
        expect(validateLevel(level, Object.keys(FACT_CARDS))).toEqual([])
      })

      it('starts unsolved: the initial scene fails at least one objective', () => {
        const run = runLevel(level, level.initialScene)
        expect(run.objectives.some((objective) => !objective.met)).toBe(true)
        expect(run.starCount).toBe(0)
      })

      it('is solvable: the reference solution meets every objective and earns three stars', () => {
        const run = runLevel(level, level.referenceSolution)
        expect(run.objectives.filter((objective) => !objective.met)).toEqual([])
        expect(run.findings).toEqual([])
        expect(run.stars).toEqual({ works: true, leastPrivilege: true, wellArchitected: true })
      })

      it('has narrator steps the reference solution can complete', () => {
        // Every "scene" trigger must be true in the finished scene, or the narrator would stick.
        const run = runLevel(level, level.referenceSolution)
        for (const step of level.narration) {
          if (step.advanceWhen.kind !== 'scene') continue
          const [result] = [step.advanceWhen.predicate].map(
            (predicate) =>
              runLevel(
                { ...level, objectives: [{ id: step.id, text: step.id, predicate }] },
                level.referenceSolution,
              ).objectives[0],
          )
          expect(result?.met, `narration step "${step.id}"`).toBe(true)
        }
        expect(run.kiteRuns.length).toBe(level.population.length)
      })
    })
  }
})

describe('validateLevel', () => {
  const broken = (change: (level: Record<string, unknown>) => void) => {
    const copy = structuredClone(LEVELS[0]) as unknown as Record<string, unknown>
    change(copy)
    return validateLevel(copy, Object.keys(FACT_CARDS))
  }

  it('rejects a value that is not an object', () => {
    expect(validateLevel('nope', [])).toEqual(['level: expected an object'])
  })

  it('names the field when a required field is missing or mistyped', () => {
    expect(broken((level) => delete level.title)).toContain('title: expected a string')
    expect(broken((level) => (level.region = 'mars-1'))[0]).toMatch('region:')
  })

  it('rejects a kite aimed at something the level can never contain', () => {
    const errors = broken(
      (level) => ((level.population as { destinationId: string }[])[0]!.destinationId = 'nowhere'),
    )
    expect(errors[0]).toMatch('population[0].destinationId')
  })

  it('rejects a Cloudling address outside the documentation ranges', () => {
    const errors = broken((level) => ((level.population as { ip: string }[])[0]!.ip = '8.8.8.8'))
    expect(errors[0]).toMatch('population[0].ip')
  })

  it('rejects a reference solution that changes something locked', () => {
    const errors = broken((level) => {
      const scene = level.referenceSolution as {
        securityGroups: { id: string; inbound: unknown[] }[]
      }
      scene.securityGroups.find((group) => group.id === 'sg-app')!.inbound = []
    })
    expect(errors).toContain(
      'referenceSolution: "sg-app" is locked but differs from the initial scene',
    )
  })

  it('rejects a reference solution that uses a cloud the palette does not offer', () => {
    const errors = broken((level) => (level.palette = []))
    expect(
      errors.some((error) => error.includes('neither in the initial scene nor in the palette')),
    ).toBe(true)
  })

  it('rejects an objective with no hint and an unknown fact card', () => {
    expect(broken((level) => (level.hints = [])).some((error) => error.startsWith('hints:'))).toBe(
      true,
    )
    expect(broken((level) => (level.factCards = ['missing']))[0]).toMatch('factCards[0]')
  })
})
