import { beforeEach, describe, expect, test } from 'vitest'
import { handleKeysApi, handlePoolApi } from './adminApi.js'
import { createApiKey, deleteApiKey, getApiKey, listApiKeys, resolveApiKey, toView, touchApiKey, updateApiKey } from './apikeys.js'
import { resetKv } from './kv.js'
import { resetXSessions } from './xsearch.js'

beforeEach(() => {
  resetKv()
  resetXSessions([
    { id: 'a', authToken: 'tokA', ct0: 'csrfA' },
    { id: 'b', authToken: 'tokB', ct0: 'csrfB' },
  ])
})

describe('api key store', () => {
  test('create returns a one-time secret that resolves back to the record', async () => {
    const { record, secret } = await createApiKey('alice', 50)
    expect(secret).toMatch(/^xmd_[0-9a-f]{48}$/)
    expect(toView(record)).not.toHaveProperty('hash')
    const resolved = await resolveApiKey(secret)
    expect(resolved).toMatchObject({ id: record.id, label: 'alice', limitPer15m: 50, disabled: false })
  })

  test('unknown, disabled, and empty keys are handled distinctly', async () => {
    expect(await resolveApiKey(undefined)).toBeNull()
    expect(await resolveApiKey('xmd_nope')).toBe('invalid')
    const { secret, record } = await createApiKey('bob', 10)
    await updateApiKey(record.id, { disabled: true })
    expect(await resolveApiKey(secret)).toBe('invalid')
  })

  test('touch stamps activity without overwriting a concurrent admin edit', async () => {
    const { record } = await createApiKey('dan', 10)
    const stale = { ...record } // snapshot held by an in-flight request
    await updateApiKey(record.id, { disabled: true, limitPer15m: 99 })
    await touchApiKey(stale, 1_700_000_000_000)
    const after = await getApiKey(record.id)
    expect(after).toMatchObject({ disabled: true, limitPer15m: 99, lastUsedAt: 1_700_000_000_000 })
    expect((await listApiKeys())[0]?.lastUsedAt).toBe(1_700_000_000_000)
  })

  test('delete revokes the secret immediately', async () => {
    const { secret, record } = await createApiKey('carol', 10)
    expect(await deleteApiKey(record.id)).toBe(true)
    expect(await resolveApiKey(secret)).toBe('invalid')
    expect(await deleteApiKey(record.id)).toBe(false)
  })
})

describe('admin api', () => {
  test('lists, creates, updates, and reports the pool', async () => {
    const created = await handleKeysApi('POST', { label: 'dave', limitPer15m: 30 })
    expect(created.status).toBe(201)
    const list = (await handleKeysApi('GET', {})).body as { keys: unknown[]; defaultLimit: number }
    expect(list.keys).toHaveLength(1)
    expect(list.defaultLimit).toBe(26) // floor(2 * 40 / 3)

    const pool = (await handlePoolApi()).body as Record<string, number | boolean> & { share: { publicCap: number; idleReleaseMinutes: number; keys: unknown[] } }
    expect(pool.poolPer15m).toBe(80)
    expect(pool.perAccountBudget).toBe(40)
    expect(pool.activeKeyCount).toBe(1)
    expect(pool.allocatedToKeysPer15m).toBe(30)
    // A freshly created key has never been used, so it is idle and holds nothing back yet.
    expect(pool.share).toMatchObject({ publicCap: 80, idleReleaseMinutes: 60 })
    expect(pool.share.keys).toHaveLength(1)
  })

  test('PATCH pool updates the idle release setting and rejects bad input', async () => {
    expect((await handlePoolApi('PATCH', { idleReleaseMinutes: 0 })).status).toBe(400)
    const updated = (await handlePoolApi('PATCH', { idleReleaseMinutes: 45 })).body as { share: { idleReleaseMinutes: number } }
    expect(updated.share.idleReleaseMinutes).toBe(45)
    expect((await handlePoolApi('PUT')).status).toBe(405)
  })

  test('creating without a limit falls back to the default; explicit bad limits are rejected', async () => {
    const created = (await handleKeysApi('POST', { label: 'eve' })).body as { key: { limitPer15m: number; id: string } }
    expect(created.key.limitPer15m).toBe(26)
    expect((await handleKeysApi('POST', { label: 'bad', limitPer15m: 0 })).status).toBe(400)
    expect((await handleKeysApi('PATCH', { id: created.key.id, limitPer15m: -3 })).status).toBe(400)
    expect((await handleKeysApi('PATCH', { id: created.key.id, limitPer15m: 'nope' })).status).toBe(400)
    expect((await getApiKey(created.key.id))?.limitPer15m).toBe(26)
  })
})
