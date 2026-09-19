import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildCacheKey, getCached, resetMemoryCache, setCached, withCache } from './cache.js'

/**
 * A fake of the Upstash/Vercel KV REST `pipeline` endpoint backed by one Map, so
 * two "instances" (a fresh in-process memory map each) can share entries the way
 * serverless instances do in production.
 */
function fakeRedis() {
  const store = new Map<string, string>()
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const commands = JSON.parse(String(init.body)) as (string | number)[][]
    const replies = commands.map(([op, key, value]) => {
      if (op === 'SET') {
        store.set(String(key), String(value))
        return { result: 'OK' }
      }
      if (op === 'GET') return { result: store.get(String(key)) ?? null }
      throw new Error(`unexpected command ${op}`)
    })
    return new Response(JSON.stringify(replies), { status: 200 })
  })
  return { fetch, store }
}

beforeEach(() => {
  resetMemoryCache()
  // Keep these tests to the memory + shared layers; disk is local-dev only.
  vi.stubEnv('CACHE_PERSIST', '0')
})

afterEach(() => {
  resetMemoryCache()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('buildCacheKey is stable regardless of field order', () => {
  expect(buildCacheKey({ b: 2, a: 1 })).toBe(buildCacheKey({ a: 1, b: 2 }))
})

test('a fresh instance reads a value another instance stored in the shared cache', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch, store } = fakeRedis()
  vi.stubGlobal('fetch', fetch)

  await setCached('k', { markdown: 'hello' })
  expect(store.size).toBe(1)

  // A different serverless instance starts with an empty memory map.
  resetMemoryCache()
  const hit = await getCached<{ markdown: string }>('k')
  expect(hit).toEqual({ value: { markdown: 'hello' }, status: 'hit' })
})

test('withCache runs the origin once across two isolated instances', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  vi.stubGlobal('fetch', fakeRedis().fetch)
  const origin = vi.fn(async () => ({ n: 1 }))

  const first = await withCache('shared-key', false, origin)
  expect(first.status).toBe('miss')

  resetMemoryCache()
  const second = await withCache('shared-key', false, origin)
  expect(second).toEqual({ value: { n: 1 }, status: 'hit' })
  expect(origin).toHaveBeenCalledTimes(1)
})

test('the shared write sets a Redis expiry from the entry TTL', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch: fetchMock } = fakeRedis()
  vi.stubGlobal('fetch', fetchMock)

  await setCached('k', { markdown: 'x' }, 60_000)
  const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
  expect(body[0][0]).toBe('SET')
  expect(body[0][1]).toMatch(/^cache:[0-9a-f]{64}$/)
  expect(body[0][3]).toBe('EX')
  expect(body[0][4]).toBe(60)
})

test('a degraded value keeps its shorter TTL on the shared write', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch: fetchMock } = fakeRedis()
  vi.stubGlobal('fetch', fetchMock)

  await withCache('degraded', false, async () => ({ degraded: true }), (v) => (v.degraded ? 30_000 : undefined))
  // withCache reads (GET) before it writes (SET); the expiry rides on the SET.
  const setCall = fetchMock.mock.calls
    .map((call) => JSON.parse((call[1] as RequestInit).body as string)[0])
    .find((command) => command[0] === 'SET')
  expect(setCall[4]).toBe(30)
})

test('a shared-store failure falls through to the origin instead of throwing', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))

  const result = await withCache('k', false, async () => ({ ok: true }))
  expect(result).toEqual({ value: { ok: true }, status: 'miss' })
})

test('without a shared store a fresh instance misses (per-process only)', async () => {
  await setCached('k', { markdown: 'local' })
  resetMemoryCache()
  expect(await getCached('k')).toBeUndefined()
})

test('a malformed shared entry is a miss, not a permanent hit', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch, store } = fakeRedis()
  vi.stubGlobal('fetch', fetch)

  await setCached('k', { markdown: 'stored' })
  const sharedKey = [...store.keys()][0]!
  // An entry with no `expiresAt` has no expiry to compare against, so it must
  // not be served instead of the origin.
  store.set(sharedKey, JSON.stringify({ value: { markdown: 'malformed' } }))

  resetMemoryCache()
  const origin = vi.fn(async () => ({ markdown: 'fresh' }))
  const result = await withCache('k', false, origin)
  expect(result).toEqual({ value: { markdown: 'fresh' }, status: 'miss' })
  expect(origin).toHaveBeenCalledTimes(1)
})
