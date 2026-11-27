// Level 8, Under Lock (ADR 0018): the edits behind the encryption controls, where keys
// are drawn, and what the sky shows when a breach is fixed.
//
// AWS behaviour these edits keep to:
// - RDS can encrypt a database only when it is created; an encrypted copy (snapshot,
//   copy with encryption, restore) replaces it.
//   https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html
// - A KMS key is deleted only after a waiting period of 7 to 30 days, and data under a
//   deleted key cannot be decrypted.
//   https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html
// - Changing a bucket's default encryption leaves existing objects as they are.
//   https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html
// - CloudTrail records every call to KMS, including GenerateDataKey and Decrypt, and
//   Event history keeps 90 days of management events with no setup.
//   https://docs.aws.amazon.com/kms/latest/developerguide/logging-using-cloudtrail.html
//   https://docs.aws.amazon.com/awscloudtrail/latest/userguide/view-cloudtrail-events.html

import { describe, expect, it } from 'vitest'
import type { Scene } from '../../src/engine'
import {
  addRoleStatement,
  keyUsers,
  placeFromPalette,
  removeResource,
  replaceDatabaseWithEncryptedCopy,
  roleStatementProblem,
  setBlockPublicAccess,
  setBucketEncryption,
  setPublicRead,
} from '../../src/game/edits'
import { layoutScene, SKY } from '../../src/game/layout'
import { createStore, readyToFly, rehearse } from '../../src/game/store'
import { LEVELS } from '../../src/levels'

const level = LEVELS.find((candidate) => candidate.slug === 'under-lock')
if (!level) throw new Error('Level 8 is missing')
const keyEntry = level.palette[0]
if (!keyEntry) throw new Error('Level 8 has no key in its tray')

const withKey = (): Scene => placeFromPalette(structuredClone(level.initialScene), keyEntry)
const database = (scene: Scene) => {
  const found = scene.resources.find((resource) => resource.id === 'db')
  if (found?.kind !== 'rds-database') throw new Error('no database')
  return found
}

describe('replacing a database with an encrypted copy', () => {
  it('encrypts it under the chosen key and changes nothing else', () => {
    const before = database(withKey())
    const after = database(replaceDatabaseWithEncryptedCopy(withKey(), 'db', 'shop-key'))
    expect(after.encryption).toEqual({ kind: 'kms', keyId: 'shop-key' })
    expect({ ...after, encryption: before.encryption }).toEqual(before)
  })

  it('can use the AWS managed key aws/rds', () => {
    expect(database(replaceDatabaseWithEncryptedCopy(withKey(), 'db', null)).encryption).toEqual({
      kind: 'kms',
      keyId: null,
    })
  })
})

describe('a KMS key that still encrypts something', () => {
  const inUse = () =>
    replaceDatabaseWithEncryptedCopy(
      setBucketEncryption(withKey(), 'receipts', { kind: 'sse-kms', keyId: 'shop-key' }),
      'db',
      'shop-key',
    )

  it('lists what it protects', () => {
    expect(keyUsers(inUse(), 'shop-key')).toEqual(['receipts', 'orders database'])
  })

  it('cannot be removed', () => {
    const scene = inUse()
    expect(removeResource(scene, 'shop-key')).toBe(scene)
  })

  it('can be removed once nothing uses it', () => {
    const scene = removeResource(withKey(), 'shop-key')
    expect(scene.resources.some((resource) => resource.id === 'shop-key')).toBe(false)
  })
})

describe('role statements the card refuses', () => {
  it('refuses kms:Use on a bucket and s3 actions on a key', () => {
    const scene = withKey()
    expect(
      roleStatementProblem(scene, { effect: 'allow', actions: ['kms:Use'], resource: 'receipts' }),
    ).toBe('kms:Use is about a KMS key, and "receipts" is not one.')
    expect(
      roleStatementProblem(scene, { effect: 'allow', actions: ['s3:Write'], resource: 'shop-key' }),
    ).toBe('s3:Write is about an S3 bucket, and "shop-key" is not one.')
    const refused = addRoleStatement(scene, 'app-role', {
      effect: 'allow',
      actions: ['kms:Use'],
      resource: 'receipts',
    })
    expect(refused).toBe(scene)
  })

  it('accepts kms:Use on the key, or on every resource', () => {
    const scene = withKey()
    expect(
      roleStatementProblem(scene, { effect: 'allow', actions: ['kms:Use'], resource: 'shop-key' }),
    ).toBeNull()
    expect(
      roleStatementProblem(scene, { effect: 'allow', actions: ['kms:Use'], resource: '*' }),
    ).toBeNull()
  })
})

describe('where Level 8 is drawn', () => {
  it('puts the KMS key in the high band, beside the role', () => {
    const layout = layoutScene(withKey())
    const key = layout.clouds['shop-key']
    const role = layout.clouds['app-role']
    if (!key || !role) throw new Error('the key or the role is not laid out')
    expect(key.y).toBeGreaterThanOrEqual(SKY.high.top)
    expect(key.y + key.height).toBeLessThanOrEqual(SKY.high.bottom)
    expect(key.x).toBeGreaterThan(role.x + role.width)
  })

  it('lifts the web servers above the database that shares their subnet', () => {
    const layout = layoutScene(level.initialScene)
    const server = layout.clouds['app-a']
    const db = layout.clouds['db']
    if (!server || !db) throw new Error('the web server or the database is not laid out')
    // The server's caption sits about 16 pixels below its cloud; it must clear the database.
    expect(server.y + server.height + 22).toBeLessThanOrEqual(db.y)
  })
})

describe('a breach that is fixed before the next flight', () => {
  // The sky snaps the attacker's string as soon as a rehearsal of the changed sky would
  // turn the attacker away (render.ts, skyView.ts).
  const outcome = (scene: Scene) =>
    rehearse(level, scene).kiteRuns.find((kiteRun) => kiteRun.kite.id === 'red-reader')?.result
      .outcome

  it('is a breach while the bucket is public', () => {
    expect(outcome(level.initialScene)).toBe('breach')
  })

  it('is no longer a breach once Block Public Access is on, or the public statement is gone', () => {
    expect(outcome(setBlockPublicAccess(level.initialScene, 'receipts', true))).toBe('blocked')
    expect(outcome(setPublicRead(level.initialScene, 'receipts', false))).toBe('blocked')
  })

  it('stays a breach when only the encryption changes', () => {
    const encrypted = setBucketEncryption(withKey(), 'receipts', {
      kind: 'sse-kms',
      keyId: 'shop-key',
    })
    expect(outcome(encrypted)).toBe('breach')
  })

  it('is rehearsed once per scene', () => {
    const scene = level.initialScene
    expect(rehearse(level, scene)).toBe(rehearse(level, scene))
  })
})

describe('the Fly button on Level 8', () => {
  it('points once the bucket is closed, at the step that asks for it', () => {
    const store = createStore(level)
    store.startRun()
    store.finishRun() // brief
    store.acknowledgeNarration() // what happened
    expect(store.getState().level.narration[store.getState().narrationIndex]?.id).toBe('close')
    expect(readyToFly(store.getState())).toBe(false)
    store.applyEdit((scene) => setBlockPublicAccess(scene, 'receipts', true))
    expect(readyToFly(store.getState())).toBe(true)
  })
})

describe("Level 8 carries Level 7's defences", () => {
  // The São Paulo levels are one shop (ADR 0019): what the player built at the edge in
  // Level 7 is still there, locked, in Level 8, and it does nothing for the bucket.
  const wrongKite = LEVELS.find((candidate) => candidate.slug === 'the-wrong-kite')
  if (!wrongKite) throw new Error('Level 7 is missing')
  const edgeOf = (scene: Scene) => scene.networkAcls.find((acl) => acl.id === 'edge-acl')
  const webAclOf = (scene: Scene) =>
    scene.resources.find((resource) => resource.kind === 'waf-web-acl')

  it('starts with the network ACL and web ACL that Level 7 ends with', () => {
    expect(edgeOf(level.initialScene)).toEqual(edgeOf(wrongKite.referenceSolution))
    expect(webAclOf(level.initialScene)).toEqual(webAclOf(wrongKite.referenceSolution))
    for (const id of ['public-a', 'public-b'])
      expect(level.initialScene.subnets.find((subnet) => subnet.id === id)?.networkAclId).toBe(
        'edge-acl',
      )
  })

  it('locks them', () => {
    expect(level.lockedIds).toContain('edge-acl')
    expect(level.lockedIds).toContain('shop-waf')
  })

  it('lets visitors through them, but they do not stand between the internet and S3', () => {
    const run = rehearse(level, level.initialScene)
    const visitor = run.kiteRuns.find((kiteRun) => kiteRun.kite.id === 'green-1')?.result
    const checks = visitor?.trace.map((step) => step.check) ?? []
    expect(checks).toContain('nacl')
    expect(checks).toContain('waf')
    const reader = run.kiteRuns.find((kiteRun) => kiteRun.kite.id === 'red-reader')?.result
    // Its address is in edge-acl's block-listed range, and still it reads the bucket.
    expect(reader?.outcome).toBe('breach')
    expect(reader?.trace.some((step) => step.check === 'nacl' || step.check === 'waf')).toBe(false)
  })
})

describe('where Level 8 says key use is recorded', () => {
  it('links the CloudTrail card where the auditor asks for every use logged', () => {
    const step = level.narration.find((candidate) => candidate.id === 'key')
    expect(step?.text).toContain('(card:cloudtrail)')
  })

  it('lists the CloudTrail card on the results card', () => {
    expect(level.factCards).toContain('cloudtrail')
  })
})
