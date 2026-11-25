// Crowd playback: how the engine's crowd record is placed on the clock and the ground.
//
// Nothing here is AWS behaviour (that is tested in tests/engine/auto-scaling.test.ts);
// these tests pin the pace and legibility Simon asked for (ADR 0012): groups 5 s apart,
// one kite per Cloudling, a fleet that visibly grows and shrinks, a dial that moves,
// and a CloudWatch log that says what happened.

import { describe, expect, it } from 'vitest'
import {
  ALARM_AT,
  alarmAt,
  crowdCuesBetween,
  crowdLog,
  crowdRunDuration,
  crowdSpots,
  dialCpuAt,
  fleetSizes,
  fleetViewAt,
  memberViewAt,
  memberVisits,
  membersTimedOut,
  TICK_DURATION,
  WALK_TICKS,
} from '../../src/game/crowdPlayback'
import { LEVELS, MAX_CROWD, runLevel } from '../../src/levels'

const level = LEVELS.find((candidate) => candidate.id === 5)!
const solved = runLevel(level, level.referenceSolution).crowd!
const unsolved = runLevel(level, level.initialScene).crowd!
const at = (minute: number, fraction = 0) => (minute + fraction) * TICK_DURATION

describe('the pace of Crowd Day', () => {
  it('brings each new group on five seconds after the one before', () => {
    const arrivals = level.events
      .filter((event) => event.kind === 'crowd-arrives')
      .map((event) => event.atTick * TICK_DURATION)
    const gaps = arrivals.slice(1).map((time, index) => time - arrivals[index]!)
    expect(gaps.length).toBeGreaterThan(1)
    expect(gaps.every((gap) => gap === 5000)).toBe(true)
  })

  it('lasts about half a minute, slow enough to watch', () => {
    expect(crowdRunDuration(solved)).toBeGreaterThan(30000)
  })

  it('has a place on the ground for the biggest crowd a level may have', () => {
    expect(crowdSpots(level.population).length).toBeGreaterThanOrEqual(MAX_CROWD)
  })
})

describe('one Cloudling in the crowd', () => {
  const spot = { x: 500, y: 612 }
  // Member 4 is the first newcomer: it arrives with the first group and leaves with the last.
  const visits = memberVisits(solved, 4)

  it('arrives with its group and leaves with it', () => {
    expect(visits).toEqual([{ arrive: 2, leave: 22 }])
  })

  it('walks on with its kite in hand before it counts, then flies its kite', () => {
    const walking = memberViewAt(solved, 4, spot, at(2 - WALK_TICKS / 2))
    expect(walking?.walking).toBe(true)
    expect(walking?.aloft).toBe(0)
    expect(walking?.feet.x).not.toBe(spot.x)
    const standing = memberViewAt(solved, 4, spot, at(3))
    expect(standing?.feet).toEqual(spot)
    expect(standing?.aloft).toBe(1)
    expect(standing?.fate).toBe('delivered')
  })

  it('is not on the field before it sets off, nor after it has walked away', () => {
    expect(memberViewAt(solved, 4, spot, at(0))).toBeNull()
    expect(memberViewAt(solved, 4, spot, at(22 + WALK_TICKS + 0.1))).toBeNull()
  })

  it('a regular is there from the start, already flying', () => {
    expect(memberViewAt(solved, 0, spot, 0)?.aloft).toBe(1)
  })

  it('a kite with no room sags; with room it flies', () => {
    // Two small instances, nineteen Cloudlings from minute 6: nine have no room.
    const sagging = Array.from({ length: 19 }, (_, member) =>
      memberViewAt(unsolved, member, spot, at(7)),
    ).filter((view) => view && view.sag === 1)
    expect(sagging).toHaveLength(9)
    expect(memberViewAt(solved, 4, spot, at(7))?.sag).toBe(0)
  })
})

describe('the fleet', () => {
  it('grows 2 → 4 → 8 → 16 and shrinks back for the reference solution', () => {
    expect(fleetSizes(solved)).toEqual([2, 4, 8, 16, 8, 4, 2])
  })

  it('shows instances launching from the moment the alarm rings, and serving two minutes later', () => {
    expect(fleetViewAt(solved, 'asg', at(2, ALARM_AT - 0.05))?.launching).toBe(0)
    const launched = fleetViewAt(solved, 'asg', at(2, ALARM_AT + 0.05))
    expect(launched?.launching).toBe(2)
    expect(launched?.serving).toBe(2)
    const halfway = fleetViewAt(solved, 'asg', at(3, 0.5))?.launchProgress ?? 0
    expect(halfway > 0 && halfway < 1).toBe(true)
    expect(fleetViewAt(solved, 'asg', at(4))).toMatchObject({ serving: 4, launching: 0 })
  })

  it('fades out the instances it removes, then shows the smaller fleet', () => {
    const removing = fleetViewAt(solved, 'asg', at(15, 0.9))
    expect(removing?.leaving).toBe(8)
    expect(removing!.leaveFade).toBeGreaterThan(0.5)
    expect(fleetViewAt(solved, 'asg', at(16))?.serving).toBe(8)
  })

  it('knows whether a load balancer sends it kites', () => {
    expect(fleetViewAt(solved, 'asg', at(1))?.attached).toBe(true)
  })
})

describe('the CloudWatch dial and alarm', () => {
  it('moves the needle from one minute’s CPU to the next rather than jumping', () => {
    // Minute 3: 90% (nine kites, room for ten). Minute 4: 45% (room for twenty).
    expect(dialCpuAt(solved, at(4))).toBe(90)
    const moving = dialCpuAt(solved, at(4, 0.15))
    expect(moving < 90 && moving > 45).toBe(true)
    expect(dialCpuAt(solved, at(4, 0.6))).toBe(45)
  })

  it('shows a minute’s alarm from the moment it is decided', () => {
    expect(alarmAt(solved, at(2, ALARM_AT - 0.05))).toBe('ok')
    expect(alarmAt(solved, at(2, ALARM_AT + 0.05))).toBe('high-cpu')
  })
})

describe('the CloudWatch log', () => {
  const lines = crowdLog(solved, 50).map((entry) => `${entry.minute}: ${entry.text}`)

  it('says when each group arrives, what the alarm did, and when new instances serve', () => {
    expect(lines).toContain('2: 5 more arrive: 9 Cloudlings, room for 10, CPU 90%')
    expect(lines).toContain('2: ALARM: CPU above 50%. Launching 2 instances')
    expect(lines).toContain('4: 2 new instances serving: room for 20, CPU 45%')
    expect(lines).toContain('15: ALARM: CPU below 50%. Removing 8 instances')
  })

  it('says how many kites timed out, and when, when there is not enough room', () => {
    const unsolvedLines = crowdLog(unsolved, null).map((entry) => `${entry.minute}: ${entry.text}`)
    expect(unsolvedLines).toContain('6: 9 kites timed out: no room (HTTP 504)')
  })

  it('counts the Cloudlings whose kites timed out, not kite-minutes', () => {
    expect(membersTimedOut(solved)).toBe(0)
    const timedOut = membersTimedOut(unsolved)
    expect(timedOut > 0 && timedOut <= MAX_CROWD).toBe(true)
  })
})

describe('sound', () => {
  it('is quiet in a steady minute: cues only mark changes', () => {
    // Minute 5 changes nothing: same crowd, same fleet, no alarm.
    expect(crowdCuesBetween(solved, at(5), at(6) - 1)).toEqual([])
  })

  it('rings the bell when the alarm goes into ALARM', () => {
    const cues = crowdCuesBetween(solved, at(2), at(3))
    expect(cues.some((cue) => cue.sound === 'alarm-bell')).toBe(true)
  })
})
