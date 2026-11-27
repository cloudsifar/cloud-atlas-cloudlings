// Level 9, No Keys at the Door (ADR 0020): played through the way a player plays it,
// with the game's own edits and flights, step by step.
//
// AWS behaviour behind the steps (tests/engine/session-manager.test.ts has the rules):
// - A bastion host needs a public address in a public subnet, SSH allowed from known
//   addresses, and the private instances allowing SSH from the bastion's group.
//   https://aws.amazon.com/solutions/implementations/linux-bastion/
// - Session Manager needs no inbound port, no bastion and no SSH key; the instance's
//   role must allow the agent to register, and the agent needs HTTPS 443 out.
//   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html
//   https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html

import { describe, expect, it } from 'vitest'
import type { Scene } from '../../src/engine'
import {
  addNetworkAclRule,
  addRoleStatement,
  addSecurityGroupRule,
  placeFromPalette,
  removeNetworkAclRule,
  removeResource,
  removeSecurityGroupRule,
  roleStatementProblem,
  setRoute,
  validSubnetsFor,
} from '../../src/game/edits'
import { layoutScene, SKY } from '../../src/game/layout'
import { createStore, readyToFly, type Store } from '../../src/game/store'
import { LEVELS, populationAt } from '../../src/levels'

const level = LEVELS.find((candidate) => candidate.slug === 'no-keys-at-the-door')
if (!level) throw new Error('Level 9 is missing')
const OPERATOR = '203.0.113.25/32'

const entry = (id: string) => {
  const found = level.palette.find((candidate) => candidate.resource.id === id)
  if (!found) throw new Error(`no "${id}" in the tray`)
  return found
}
const stepId = (store: Store) => level.narration[store.getState().narrationIndex]?.id
const fly = (store: Store) => {
  const run = store.startRun()
  store.finishRun()
  return run
}
const kiteRun = (run: ReturnType<Store['startRun']>, id: string) =>
  run.kiteRuns.find((candidate) => candidate.kite.id === id)

describe('Level 9 played through', () => {
  it('follows the narrator from a closed door, to a bastion, to Session Manager', () => {
    const store = createStore(level)
    const edit = (change: (scene: Scene) => Scene) => store.applyEdit(change)
    const next = () => store.acknowledgeNarration()

    expect(stepId(store)).toBe('brief')
    let run = fly(store)
    // Nothing has a public address: neither the probe nor the operator gets anywhere.
    expect(kiteRun(run, 'operator')?.result.outcome).toBe('blocked')
    expect(kiteRun(run, 'red-probe')?.result.outcome).toBe('blocked')
    expect(stepId(store)).toBe('what-happened')
    next()

    expect(stepId(store)).toBe('bastion')
    expect(
      validSubnetsFor(store.getState().scene, entry('bastion').resource).map((s) => s.id),
    ).toEqual(['public-a', 'public-b'])
    edit((scene) => placeFromPalette(scene, entry('bastion'), 'public-a'))
    expect(readyToFly(store.getState())).toBe(true)
    run = fly(store)
    expect(
      run.kiteRuns.find((each) => each.kite.id === 'operator')?.result.trace.at(-1)?.check,
    ).toBe('nacl')
    expect(store.getState().scene).toEqual(level.narrationCheckpoints?.bastion)

    expect(stepId(store)).toBe('edge')
    edit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'inbound', {
        number: 110,
        action: 'allow',
        ports: 'ssh',
        peer: { kind: 'cidr', cidr: OPERATOR },
      }),
    )
    expect(readyToFly(store.getState())).toBe(false) // the hop out still needs its rule
    edit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'outbound', {
        number: 210,
        action: 'allow',
        ports: 'ssh',
        peer: { kind: 'cidr', cidr: '10.0.0.0/16' },
      }),
    )
    run = fly(store)
    expect(store.getState().scene).toEqual(level.narrationCheckpoints?.edge)

    expect(stepId(store)).toBe('bastion-sg')
    edit((scene) =>
      addSecurityGroupRule(scene, 'sg-bastion', 'inbound', {
        ports: 'ssh',
        peer: { kind: 'cidr', cidr: OPERATOR },
      }),
    )
    run = fly(store)
    expect(store.getState().scene).toEqual(level.narrationCheckpoints?.['bastion-sg'])

    expect(stepId(store)).toBe('app-sg')
    edit((scene) =>
      addSecurityGroupRule(scene, 'sg-app', 'inbound', {
        ports: 'ssh',
        peer: { kind: 'security-group', securityGroupId: 'sg-bastion' },
      }),
    )
    run = fly(store)
    expect(kiteRun(run, 'operator')?.result.outcome).toBe('delivered')
    // The probe knocks at the bastion and edge-acl turns it away.
    expect(kiteRun(run, 'red-probe')?.result.outcome).toBe('blocked')
    expect(store.getState().scene).toEqual(level.narrationCheckpoints?.['app-sg'])

    expect(stepId(store)).toBe('look')
    next()

    // The twist: the operator works from the coast, from a new address.
    expect(stepId(store)).toBe('twist')
    const operatorNow = populationAt(level, store.getState().narrationIndex).find(
      (kite) => kite.id === 'operator',
    )
    expect(operatorNow?.ip).toBe('192.0.2.77')
    expect(readyToFly(store.getState())).toBe(true)
    run = fly(store)
    expect(kiteRun(run, 'operator')?.result.outcome).toBe('blocked')
    expect(kiteRun(run, 'operator')?.kite.ip).toBe('192.0.2.77')

    expect(stepId(store)).toBe('temptation')
    next()

    expect(stepId(store)).toBe('ssm')
    edit((scene) => placeFromPalette(scene, entry('ssm')))
    expect(stepId(store)).toBe('role')
    edit((scene) =>
      addRoleStatement(scene, 'app-role', {
        effect: 'allow',
        actions: ['ssm:ManagedInstance'],
        resource: 'ssm',
      }),
    )

    expect(stepId(store)).toBe('nat')
    edit((scene) => placeFromPalette(scene, entry('nat'), 'public-b'))
    edit((scene) =>
      setRoute(scene, 'rt-private', {
        destination: 'internet',
        target: { kind: 'nat-gateway', natGatewayId: 'nat' },
      }),
    )
    run = fly(store)
    // Stateless: the NAT Gateway's subnet is behind edge-acl, which has no HTTPS out.
    const stopped = kiteRun(run, 'operator')?.result.trace.at(-1)
    expect(stopped?.check).toBe('nacl')
    expect(stopped?.at).toEqual({ kind: 'subnet', id: 'public-b' })

    expect(stepId(store)).toBe('nat-acl')
    edit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'outbound', {
        number: 300,
        action: 'allow',
        ports: 'https',
        peer: { kind: 'anywhere' },
      }),
    )
    edit((scene) =>
      addNetworkAclRule(scene, 'edge-acl', 'inbound', {
        number: 300,
        action: 'allow',
        ports: 'ephemeral',
        peer: { kind: 'anywhere' },
      }),
    )
    run = fly(store)
    expect(kiteRun(run, 'operator')?.result.outcome).toBe('delivered')
    // A session works with the bastion still there; the door is still open, though.
    expect(run.objectives.find((objective) => objective.id === 'no-ssh-in')?.met).toBe(false)

    expect(stepId(store)).toBe('close')
    edit((scene) => removeResource(scene, 'bastion'))
    // bastion-sg is still named by ec2-app-sg's rule, so it stays until that rule goes.
    expect(store.getState().scene.securityGroups.some((group) => group.id === 'sg-bastion')).toBe(
      true,
    )
    const sshRule = store
      .getState()
      .scene.securityGroups.find((group) => group.id === 'sg-app')
      ?.inbound.findIndex((rule) => rule.ports === 'ssh')
    edit((scene) => removeSecurityGroupRule(scene, 'sg-app', 'inbound', sshRule ?? -1))
    expect(store.getState().scene.securityGroups.some((group) => group.id === 'sg-bastion')).toBe(
      false,
    )
    edit((scene) => removeNetworkAclRule(scene, 'edge-acl', 'inbound', 110))
    edit((scene) => removeNetworkAclRule(scene, 'edge-acl', 'outbound', 210))
    run = fly(store)

    expect(stepId(store)).toBe('wrap')
    expect(run.stars).toEqual({ works: true, leastPrivilege: true, wellArchitected: true })
    expect(store.getState().scene).toEqual(level.referenceSolution)
  })

  it('earns two stars, not three, while a rule still mentions SSH', () => {
    const scene = structuredClone(level.referenceSolution)
    const edge = scene.networkAcls.find((acl) => acl.id === 'edge-acl')
    edge?.outbound.push({
      number: 210,
      action: 'allow',
      ports: 'ssh',
      peer: { kind: 'cidr', cidr: '10.0.0.0/16' },
    })
    const store = createStore({ ...level, initialScene: scene, narration: [] })
    const run = fly(store)
    expect(run.stars.works).toBe(true)
    expect(run.stars.wellArchitected).toBe(false)
  })
})

describe('Level 9 pieces', () => {
  it('refuses ssm:ManagedInstance on anything but Session Manager', () => {
    const scene = placeFromPalette(structuredClone(level.initialScene), entry('ssm'))
    expect(
      roleStatementProblem(scene, {
        effect: 'allow',
        actions: ['ssm:ManagedInstance'],
        resource: 'receipts',
      }),
    ).toMatch('Session Manager')
    expect(
      roleStatementProblem(scene, {
        effect: 'allow',
        actions: ['ssm:ManagedInstance'],
        resource: 'ssm',
      }),
    ).toBeNull()
  })

  it('draws the bastion in the low band and Session Manager in the high band', () => {
    const scene = placeFromPalette(
      placeFromPalette(structuredClone(level.initialScene), entry('bastion'), 'public-a'),
      entry('ssm'),
    )
    const layout = layoutScene(scene)
    const bastion = layout.clouds.bastion
    const ssm = layout.clouds.ssm
    if (!bastion || !ssm) throw new Error('not laid out')
    expect(bastion.y).toBeGreaterThanOrEqual(SKY.low.top)
    expect(bastion.y + bastion.height).toBeLessThanOrEqual(SKY.low.bottom)
    expect(ssm.y).toBeGreaterThanOrEqual(SKY.high.top)
    expect(ssm.y + ssm.height).toBeLessThanOrEqual(SKY.high.bottom)
    // Clear of the other managed services and of the bucket's column.
    for (const id of ['app-role', 'shop-key']) {
      const other = layout.clouds[id]
      if (!other) throw new Error(`${id} not laid out`)
      expect(ssm.x >= other.x + other.width || other.x >= ssm.x + ssm.width).toBe(true)
    }
    expect(ssm.x + ssm.width).toBeLessThanOrEqual(SKY.s3Column.x)
  })

  it('moves the operator only once the narrator reaches the twist', () => {
    const twist = level.narration.findIndex((step) => step.id === 'twist')
    const before = populationAt(level, twist - 1).find((kite) => kite.id === 'operator')
    const after = populationAt(level, twist).find((kite) => kite.id === 'operator')
    expect(before?.ip).toBe('203.0.113.25')
    expect(after?.ip).toBe('192.0.2.77')
    expect(after?.groundPosition).not.toBe(before?.groundPosition)
  })
})
