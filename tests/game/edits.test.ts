// Player edits to an Auto Scaling group keep its settings legal.
//
// AWS behaviour: desired capacity must be at least the minimum and at most the maximum.
// https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-capacity-limits.html

import { describe, expect, it } from 'vitest'
import type { AutoScalingGroup, Scene } from '../../src/engine'
import { setGroupSettings } from '../../src/game/edits'
import { byId, sceneWith } from '../engine/fixtures'

const withGroup = (settings: Pick<AutoScalingGroup, 'min' | 'desired' | 'max'>): Scene =>
  sceneWith((scene) => {
    scene.resources.push({
      kind: 'auto-scaling-group',
      id: 'asg',
      name: 'web fleet',
      subnetIds: ['private-a', 'private-b'],
      securityGroupIds: ['sg-app'],
      roleId: null,
      size: 'small',
      scaling: null,
      ...settings,
    })
  })

const settingsAfter = (
  start: Pick<AutoScalingGroup, 'min' | 'desired' | 'max'>,
  change: Parameters<typeof setGroupSettings>[2],
) => {
  const group = byId(setGroupSettings(withGroup(start), 'asg', change).resources, 'asg')
  if (group.kind !== 'auto-scaling-group') throw new Error('expected a group')
  return { min: group.min, desired: group.desired, max: group.max }
}

describe('setGroupSettings', () => {
  it('keeps a desired capacity the player chose within the limits', () => {
    expect(settingsAfter({ min: 2, desired: 2, max: 8 }, { desired: 5 })).toEqual({
      min: 2,
      desired: 5,
      max: 8,
    })
    expect(settingsAfter({ min: 2, desired: 2, max: 8 }, { desired: 12 }).desired).toBe(8)
  })

  it('carries desired up with the minimum', () => {
    expect(settingsAfter({ min: 2, desired: 2, max: 8 }, { min: 4 })).toEqual({
      min: 4,
      desired: 4,
      max: 8,
    })
  })

  it('lifts the maximum when the minimum is raised past it', () => {
    expect(settingsAfter({ min: 2, desired: 2, max: 2 }, { min: 3 })).toEqual({
      min: 3,
      desired: 3,
      max: 3,
    })
  })

  it('lowers the minimum and desired when the maximum is lowered below them', () => {
    expect(settingsAfter({ min: 4, desired: 6, max: 8 }, { max: 3 })).toEqual({
      min: 3,
      desired: 3,
      max: 3,
    })
  })

  it('never goes below one instance', () => {
    expect(settingsAfter({ min: 1, desired: 1, max: 1 }, { min: 0, max: 0 })).toEqual({
      min: 1,
      desired: 1,
      max: 1,
    })
  })
})
