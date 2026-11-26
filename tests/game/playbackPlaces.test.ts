// Where a kite's checks are drawn (ADR 0017): a network ACL check sits where the path
// crosses the subnet's fence, on the side it crosses. Network ACLs are stateless and
// judge each direction on its own, so a reply can be dropped on its way out of a subnet
// that let the request in; the drop must be drawn at the edge facing the way out, or the
// picture teaches the wrong lesson.
// https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html

import { describe, expect, it } from 'vitest'
import { addNetworkAclRule, setSubnetNetworkAcl } from '../../src/game/edits'
import { borderCrossing, layoutScene } from '../../src/game/layout'
import { buildScript } from '../../src/game/playback'
import { LEVELS, runLevel } from '../../src/levels'

const level = LEVELS.find((candidate) => candidate.slug === 'the-wrong-kite')
if (!level) throw new Error('Level 7 is missing')

/** Level 7 with edge-acl on the public subnets and HTTPS allowed in, but no reply rule out. */
const httpsOnly = () => {
  let scene = structuredClone(level.initialScene)
  scene = setSubnetNetworkAcl(scene, 'public-a', 'edge-acl')
  scene = setSubnetNetworkAcl(scene, 'public-b', 'edge-acl')
  return addNetworkAclRule(scene, 'edge-acl', 'inbound', {
    number: 100,
    action: 'allow',
    ports: 'https',
    peer: { kind: 'anywhere' },
  })
}

const scriptFor = (scene: ReturnType<typeof httpsOnly>, kiteId: string) => {
  const run = runLevel(level, scene)
  const index = run.kiteRuns.findIndex((kiteRun) => kiteRun.kite.id === kiteId)
  const kiteRun = run.kiteRuns[index]
  if (!kiteRun) throw new Error(`no kite ${kiteId}`)
  const layout = layoutScene(scene)
  return { script: buildScript(kiteRun, scene, layout, index), layout }
}

describe('network ACL checks on the stage', () => {
  it('draw a reply dropped on its way out at the public subnet edge facing the ground', () => {
    const { script, layout } = scriptFor(httpsOnly(), 'green-1')
    const last = script.beats[script.beats.length - 1]
    const subnet = layout.subnets['public-a']
    expect(script.ending).toBe('failed')
    expect(last?.step.leg).toBe('response')
    expect(last?.step.check).toBe('nacl')
    expect(last?.step.result).toBe('fail')
    // On the bottom edge, the side the reply leaves by for the internet.
    expect(last?.position.y).toBe((subnet?.y ?? 0) + (subnet?.height ?? 0))
    // And it passes back through the load balancer on the way there.
    const balancer = layout.clouds['alb']
    expect(last?.via).toEqual({
      x: (balancer?.x ?? 0) + (balancer?.width ?? 0) / 2,
      y: (balancer?.y ?? 0) + (balancer?.height ?? 0) / 2,
    })
  })

  it('draw the reply coming back in, and the request going deeper, on the top edge', () => {
    const { script, layout } = scriptFor(httpsOnly(), 'green-1')
    const subnetTop = layout.subnets['public-a']?.y
    const crossings = script.beats.filter(
      (beat) =>
        beat.step.check === 'nacl' &&
        beat.step.at.kind === 'subnet' &&
        beat.step.at.id === 'public-a',
    )
    // In from the gateway, out towards the web server, the reply back in, the reply out.
    expect(crossings.map((beat) => beat.step.leg)).toEqual([
      'request',
      'request',
      'response',
      'response',
    ])
    expect(crossings[1]?.position.y).toBe(subnetTop)
    expect(crossings[2]?.position.y).toBe(subnetTop)
  })

  it('draw a kite turned away at the edge on the fence it was crossing', () => {
    // Before HTTPS is allowed in, every kite is denied at the first fence.
    let scene = structuredClone(level.initialScene)
    scene = setSubnetNetworkAcl(scene, 'public-a', 'edge-acl')
    scene = setSubnetNetworkAcl(scene, 'public-b', 'edge-acl')
    const { script, layout } = scriptFor(scene, 'green-1')
    const subnet = layout.subnets['public-a']
    const last = script.beats[script.beats.length - 1]
    expect(last?.step.check).toBe('nacl')
    expect(last?.position.y).toBe((subnet?.y ?? 0) + (subnet?.height ?? 0))
  })
})

describe('borderCrossing', () => {
  const rect = { x: 0, y: 0, width: 100, height: 50 }
  it('finds where a line going in crosses the fence', () => {
    expect(borderCrossing(rect, { x: 50, y: 100 }, { x: 50, y: 25 }, 'enter')).toEqual({
      x: 50,
      y: 50,
    })
  })
  it('finds where a line coming out crosses the fence', () => {
    expect(borderCrossing(rect, { x: 50, y: 25 }, { x: 50, y: -40 }, 'exit')).toEqual({
      x: 50,
      y: 0,
    })
  })
  it('falls back to the nearest fence when the line misses the subnet', () => {
    expect(borderCrossing(rect, { x: 150, y: 70 }, { x: 150, y: 10 }, 'enter')).toEqual({
      x: 100,
      y: 50,
    })
    expect(borderCrossing(rect, { x: 150, y: 10 }, { x: 150, y: 70 }, 'exit')).toEqual({
      x: 100,
      y: 50,
    })
  })
})
