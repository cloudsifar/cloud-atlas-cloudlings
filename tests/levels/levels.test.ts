// Every shipped level must be valid, unsolved at the start, and solvable.

import { describe, expect, it } from 'vitest'
import { FACT_CARDS, LEVELS, runLevel, validateLevel } from '../../src/levels'

/** Levels 1–3 are the beginner levels: every setting the narrator asks for pulses. */
const BEGINNER_LEVELS = 3

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

      it('aims every red kite at something the internet can actually reach', () => {
        // An attacker on the internet can only address a public endpoint: an
        // internet-facing load balancer, or S3. An EC2 instance in a private subnet has
        // no route from an internet gateway and only a private address, so a red kite
        // never aims at one (docs/THREATS.md).
        // https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html
        for (const kite of level.population.filter((candidate) => candidate.kind === 'hostile')) {
          const target = level.referenceSolution.resources.find(
            (resource) => resource.id === kite.destinationId,
          )
          expect(['load-balancer', 's3-bucket'], `red kite "${kite.id}"`).toContain(target?.kind)
        }
      })

      if (level.id <= BEGINNER_LEVELS) {
        it('points at the card section for every step that asks for a setting to change', () => {
          // Beginner levels pulse the section heading the player has to change (ADR 0008).
          // Placing a cloud is not a setting: the tray highlight covers that.
          for (const step of level.narration) {
            if (step.advanceWhen.kind !== 'scene') continue
            if (step.advanceWhen.predicate.kind === 'resource-exists') continue
            expect(step.pulse?.length ?? 0, `narration step "${step.id}"`).toBeGreaterThan(0)
          }
        })
      }
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

  describe('crowds and events', () => {
    const crowdLevel = LEVELS.find((level) => level.crowd !== undefined)
    const brokenCrowd = (change: (level: Record<string, unknown>) => void) => {
      const copy = structuredClone(crowdLevel) as unknown as Record<string, unknown>
      change(copy)
      return validateLevel(copy, Object.keys(FACT_CARDS))
    }
    type Surge = { atTick: number; peakKitesPerTick: number; kind: string }
    const surgeOf = (level: Record<string, unknown>) => (level.events as Surge[])[0]!

    it('ships at least one level with a crowd, so these checks are exercised', () => {
      expect(crowdLevel).toBeDefined()
    })

    it('rejects a crowd aimed at something that is not a load balancer', () => {
      const errors = brokenCrowd(
        (level) => ((level.crowd as { loadBalancerId: string }).loadBalancerId = 'nowhere'),
      )
      expect(errors[0]).toMatch('crowd.loadBalancerId')
    })

    it('rejects a crowd address outside the documentation ranges', () => {
      const errors = brokenCrowd((level) => ((level.crowd as { ip: string }).ip = '8.8.8.8'))
      expect(errors[0]).toMatch('crowd.ip')
    })

    it('rejects a surge that is still going when the run ends', () => {
      const errors = brokenCrowd((level) => (surgeOf(level).atTick = 25))
      expect(errors.some((error) => error.includes('must be over before the run ends'))).toBe(true)
    })

    it('rejects a surge no bigger than the usual crowd', () => {
      const errors = brokenCrowd((level) => (surgeOf(level).peakKitesPerTick = 2))
      expect(errors[0]).toMatch('peakKitesPerTick')
    })

    it('rejects an event it does not know', () => {
      const errors = brokenCrowd((level) => (surgeOf(level).kind = 'meteor-strike'))
      expect(errors[0]).toMatch('events[0].kind')
    })

    it('rejects a surge in a level with no crowd', () => {
      const errors = brokenCrowd((level) => delete level.crowd)
      expect(errors.some((error) => error.includes('needs the level to have a crowd'))).toBe(true)
    })

    it('rejects an objective about the surge in a level that has none', () => {
      const errors = brokenCrowd((level) => (level.events = []))
      expect(errors.some((error) => error.includes('has no crowd surge'))).toBe(true)
    })
  })

  it('rejects a pulse that names an unknown section or id', () => {
    const errors = broken((level) => {
      const steps = level.narration as { pulse?: string[] }[]
      if (steps[0]) steps[0].pulse = ['listener:no-such-thing']
    })
    expect(errors[0]).toMatch('narration[0].pulse')
  })

  it('rejects a Cloudling with nothing to say', () => {
    const errors = broken((level) => {
      const kites = level.population as { says: string }[]
      if (kites[0]) kites[0].says = ''
    })
    expect(errors[0]).toMatch('population[0].says')
  })

  it('rejects a removal warning for a cloud the player cannot remove', () => {
    const errors = broken((level) => (level.removalWarnings = { 'app-a': 'Careful!' }))
    expect(errors[0]).toMatch('removalWarnings.app-a')
  })

  it('rejects an objective with no hint and an unknown fact card', () => {
    expect(broken((level) => (level.hints = [])).some((error) => error.startsWith('hints:'))).toBe(
      true,
    )
    expect(broken((level) => (level.factCards = ['missing']))[0]).toMatch('factCards[0]')
  })
})
