import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildCacheKey, getCached, resetMemoryCache, setCached, withCache } from './cache.js'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * A fake of the Upstash/Vercel KV REST `pipeline` endpoint backed by one Map, so
 * two "instances" (a fresh in-process memory map each) can share entries the way
 * serverless instances do in production.
 */
function fakeRedis(beforeRequest?: (operation: string) => Promise<void>) {
  const store = new Map<string, string>()
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const commands = JSON.parse(String(init.body)) as (string | number)[][]
    await beforeRequest?.(String(commands[0]?.[0]))
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
  vi.stubEnv('CACHE_DISABLED', '0')
  vi.stubEnv('KV_REST_API_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
})

afterEach(() => {
  resetMemoryCache()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
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

test('a cold burst shares slow lookups, origin work and the awaited write', async () => {
  vi.useFakeTimers()
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  const { fetch } = fakeRedis(() => delay(10))
  vi.stubGlobal('fetch', fetch)
  // Model a capacity-limited origin: duplicate work queues rather than running
  // for free in parallel. The virtual clock makes the latency check repeatable.
  let queue = Promise.resolve()
  const origin = vi.fn(() => {
    const value = queue.then(async () => {
      await delay(25)
      return { markdown: 'one result' }
    })
    queue = value.then(() => {})
    return value
  })
  const started = Date.now()
  const burst = Promise.all(Array.from({ length: 10 }, () => withCache('burst', false, origin)))
  await vi.runAllTimersAsync()
  expect(await burst).toEqual(Array.from({ length: 10 }, () => ({ value: { markdown: 'one result' }, status: 'miss' })))
  expect(Date.now() - started).toBe(45)
  expect(origin).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('a caller arriving during an origin fill skips another shared lookup', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch } = fakeRedis()
  vi.stubGlobal('fetch', fetch)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const originStarted = new Promise<void>((resolve) => { started = resolve })
  const origin = vi.fn(async () => { started(); await gate; return 'fresh' })
  const first = withCache('pending', false, origin)
  await originStarted
  const second = withCache('pending', false, origin)
  expect(fetch).toHaveBeenCalledTimes(1)
  release()
  expect(await Promise.all([first, second])).toEqual([
    { value: 'fresh', status: 'miss' },
    { value: 'fresh', status: 'miss' },
  ])
  expect(origin).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('concurrent direct lookups share a durable read without caching a miss', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const { fetch } = fakeRedis(() => gate)
  vi.stubGlobal('fetch', fetch)
  const lookups = Promise.all([getCached('empty'), getCached('empty')])
  expect(fetch).toHaveBeenCalledTimes(1)
  release()
  expect(await lookups).toEqual([undefined, undefined])
  await getCached('empty')
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('a shared rejection clears the fill so a later request retries', async () => {
  let reject!: (reason: Error) => void
  let started!: () => void
  const failure = new Error('origin failed')
  const gate = new Promise<string>((_resolve, rejectOrigin) => { reject = rejectOrigin })
  const originStarted = new Promise<void>((resolve) => { started = resolve })
  const origin = vi.fn(() => { started(); return gate })
  const first = withCache('failed', false, origin)
  await originStarted
  const second = withCache('failed', false, origin)
  const rejected = Promise.allSettled([first, second])
  reject(failure)
  expect(await rejected).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'rejected', reason: failure },
  ])
  expect(origin).toHaveBeenCalledTimes(1)
  expect(await withCache('failed', false, async () => 'retry')).toEqual({ value: 'retry', status: 'miss' })
})

test('caller-scoped fills isolate admission errors but keep stored values shared', async () => {
  let started!: () => void
  let reject!: (reason: Error) => void
  const gate = new Promise<string>((_resolve, rejectOrigin) => { reject = rejectOrigin })
  const originStarted = new Promise<void>((resolve) => { started = resolve })
  const first = withCache('same-query', false, () => { started(); return gate }, undefined, 'caller-a')
  const rejected = expect(first).rejects.toThrow('caller-a limit')
  await originStarted
  const second = await withCache('same-query', false, async () => 'caller-b result', undefined, 'caller-b')
  expect(second).toEqual({ value: 'caller-b result', status: 'miss' })
  reject(new Error('caller-a limit'))
  await rejected
  const origin = vi.fn(async () => 'unneeded')
  expect(await withCache('same-query', false, origin, undefined, 'caller-c')).toEqual({ value: 'caller-b result', status: 'hit' })
  expect(origin).not.toHaveBeenCalled()
})

test.each(['nocache', '1', 'true'])('%s bypasses pending fills without reading or writing', async (mode) => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch } = fakeRedis()
  vi.stubGlobal('fetch', fetch)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const originStarted = new Promise<void>((resolve) => { started = resolve })
  const pending = withCache('bypass', false, async () => { started(); await gate; return 'cached' })
  await originStarted
  if (mode !== 'nocache') vi.stubEnv('CACHE_DISABLED', mode)
  const origin = vi.fn(async () => 'bypass')
  const results = await Promise.all([
    withCache('bypass', mode === 'nocache', origin),
    withCache('bypass', mode === 'nocache', origin),
  ])
  expect(results).toEqual(Array.from({ length: 2 }, () => ({ value: 'bypass', status: 'bypass' })))
  expect(origin).toHaveBeenCalledTimes(2)
  expect(fetch).toHaveBeenCalledTimes(1)
  release()
  await pending
  expect(await getCached('bypass')).toEqual({ value: 'cached', status: 'hit' })
})

test('a fill waits for its durable write while new callers can use hot memory', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const writeStarted = new Promise<void>((resolve) => { started = resolve })
  const { fetch } = fakeRedis(async (operation) => { if (operation === 'SET') { started(); await gate } })
  vi.stubGlobal('fetch', fetch)
  let settled = false
  const pending = withCache('write', false, async () => 'value').then((value) => { settled = true; return value })
  await writeStarted
  expect(settled).toBe(false)
  const origin = vi.fn(async () => 'other')
  expect(await withCache('write', false, origin)).toEqual({ value: 'value', status: 'hit' })
  expect(origin).not.toHaveBeenCalled()
  release()
  expect(await pending).toEqual({ value: 'value', status: 'miss' })
})

test('a slow durable write does not let new callers join an already expired value', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const writeStarted = new Promise<void>((resolve) => { started = resolve })
  const { fetch } = fakeRedis(async (operation) => { if (operation === 'SET') { started(); await gate } })
  vi.stubGlobal('fetch', fetch)
  const first = withCache('expiring-write', false, async () => 'old', () => 10)
  await writeStarted
  vi.setSystemTime(1_010)
  const origin = vi.fn(async () => 'new')
  const second = withCache('expiring-write', false, origin, () => 10)
  release()
  expect(await first).toEqual({ value: 'old', status: 'miss' })
  expect(await second).toEqual({ value: 'new', status: 'miss' })
  expect(origin).toHaveBeenCalledTimes(1)
})

test('completed flights respect a shortened TTL at the exact expiry time', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const origin = vi.fn(async () => 'degraded')
  const ttlFor = vi.fn(() => 50)
  expect(await Promise.all([
    withCache('short', false, origin, ttlFor),
    withCache('short', false, origin, ttlFor),
  ])).toEqual(Array.from({ length: 2 }, () => ({ value: 'degraded', status: 'miss' })))
  expect(ttlFor).toHaveBeenCalledTimes(1)
  vi.setSystemTime(1_049)
  expect(await withCache('short', false, origin, ttlFor)).toEqual({ value: 'degraded', status: 'hit' })
  vi.setSystemTime(1_050)
  expect(await withCache('short', false, origin, ttlFor)).toEqual({ value: 'degraded', status: 'miss' })
  expect(origin).toHaveBeenCalledTimes(2)
})

test('a reset does not let an old fill delete a newer pending flight', async () => {
  let releaseOld!: () => void
  let releaseNew!: () => void
  let oldStarted!: () => void
  let newStarted!: () => void
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
  const newGate = new Promise<void>((resolve) => { releaseNew = resolve })
  const oldReady = new Promise<void>((resolve) => { oldStarted = resolve })
  const newReady = new Promise<void>((resolve) => { newStarted = resolve })
  const first = withCache('reset', false, async () => { oldStarted(); await oldGate; return 'old' }, () => 0)
  await oldReady
  resetMemoryCache()
  const origin = vi.fn(async () => { newStarted(); await newGate; return 'new' })
  const second = withCache('reset', false, origin)
  await newReady
  releaseOld()
  await first
  const third = withCache('reset', false, origin)
  releaseNew()
  expect(await Promise.all([second, third])).toEqual([
    { value: 'new', status: 'miss' },
    { value: 'new', status: 'miss' },
  ])
  expect(origin).toHaveBeenCalledTimes(1)
})

test('unique-key fills are bounded and existing pending keys remain shared at capacity', async () => {
  let release!: () => void
  let ready!: () => void
  let started = 0
  const gate = new Promise<void>((resolve) => { release = resolve })
  const capacityReady = new Promise<void>((resolve) => { ready = resolve })
  const origin = vi.fn(async () => { if (++started === 500) ready(); await gate; return 'value' })
  const pending = Array.from({ length: 500 }, (_, i) => withCache(`cap-${i}`, false, origin))
  await capacityReady
  const existing = withCache('cap-0', false, origin)
  let overflowReady!: () => void
  const overflowStarted = new Promise<void>((resolve) => { overflowReady = resolve })
  const overflow = vi.fn(async () => { overflowReady(); await gate; return 'overflow' })
  const firstOverflow = withCache('over-cap', false, overflow)
  await overflowStarted
  const secondOverflow = withCache('over-cap', false, overflow)
  release()
  await Promise.all([...pending, existing, firstOverflow, secondOverflow])
  expect(origin).toHaveBeenCalledTimes(500)
  expect(overflow).toHaveBeenCalledTimes(2)
})

test('disk hits obey the hot-memory cap', async () => {
  vi.stubEnv('CACHE_PERSIST', '1')
  vi.stubEnv('VERCEL', '')
  const dir = await mkdtemp(path.join(tmpdir(), 'x-md-cache-'))
  vi.stubEnv('CACHE_DIR', dir)
  const fileFor = (key: string) => path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`)
  try {
    for (let i = 0; i <= 500; i++) {
      const key = `disk-${i}`
      await writeFile(fileFor(key), JSON.stringify({ value: i, storedAt: Date.now(), expiresAt: Date.now() + 60_000 }))
      expect(await getCached(key)).toEqual({ value: i, status: 'hit' })
    }
    await unlink(fileFor('disk-0'))
    expect(await getCached('disk-0')).toBeUndefined()
    await unlink(fileFor('disk-500'))
    expect(await getCached('disk-500')).toEqual({ value: 500, status: 'hit' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('admission: the durable lookup runs while the verdict is pending, and nothing is fetched or served until it allows', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  const { fetch } = fakeRedis()
  vi.stubGlobal('fetch', fetch)
  let admit!: () => void
  const admission = new Promise<void>((resolve) => { admit = resolve })
  const origin = vi.fn(async () => 'fresh')
  let settled = false
  const pending = withCache('gated', false, origin, undefined, undefined, { admission }).then((value) => { settled = true; return value })
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(origin).not.toHaveBeenCalled()
  expect(settled).toBe(false)
  admit()
  expect(await pending).toEqual({ value: 'fresh', status: 'miss' })
  expect(origin).toHaveBeenCalledTimes(1)
})

test('admission: a denial is thrown before the origin on a miss and withholds a hot hit', async () => {
  const denied = new Error('denied')
  const denial = () => { const rejected = Promise.reject(denied); rejected.catch(() => undefined); return rejected }
  const origin = vi.fn(async () => 'fresh')
  await expect(withCache('denied', false, origin, undefined, undefined, { admission: denial() })).rejects.toBe(denied)
  expect(origin).not.toHaveBeenCalled()
  expect(await withCache('denied', false, origin)).toEqual({ value: 'fresh', status: 'miss' })
  await expect(withCache('denied', false, origin, undefined, undefined, { admission: denial() })).rejects.toBe(denied)
  expect(await withCache('denied', false, origin, undefined, undefined, { admission: Promise.resolve() })).toEqual({ value: 'fresh', status: 'hit' })
  expect(origin).toHaveBeenCalledTimes(1)
})

test('admission: a caller joining another flight still waits for its own verdict', async () => {
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const originStarted = new Promise<void>((resolve) => { started = resolve })
  const first = withCache('joined', false, async () => { started(); await gate; return 'shared' })
  await originStarted
  const denied = new Error('denied')
  const denial = Promise.reject(denied)
  denial.catch(() => undefined)
  const rejected = expect(withCache('joined', false, async () => 'unused', undefined, undefined, { admission: denial })).rejects.toBe(denied)
  release()
  await rejected
  expect(await first).toEqual({ value: 'shared', status: 'miss' })
})

test('admission: a fill that landed while the verdict was pending is served instead of refetched', async () => {
  let admit!: () => void
  const admission = new Promise<void>((resolve) => { admit = resolve })
  const origin = vi.fn(async () => 'late')
  const gated = withCache('landed', false, origin, undefined, 'caller-a', { admission })
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(await withCache('landed', false, async () => 'from-b', undefined, 'caller-b')).toEqual({ value: 'from-b', status: 'miss' })
  admit()
  expect(await gated).toEqual({ value: 'from-b', status: 'hit' })
  expect(origin).not.toHaveBeenCalled()
})

test('defer: a miss is answered once hot memory holds the value, and the durable write finishes on its own', async () => {
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const writeStarted = new Promise<void>((resolve) => { started = resolve })
  const { fetch, store } = fakeRedis(async (operation) => { if (operation === 'SET') { started(); await gate } })
  vi.stubGlobal('fetch', fetch)
  const deferred: Promise<void>[] = []
  expect(await withCache('deferred', false, async () => 'value', undefined, undefined, { defer: (write) => { deferred.push(write) } })).toEqual({ value: 'value', status: 'miss' })
  await writeStarted
  expect(deferred).toHaveLength(1)
  expect(store.size).toBe(0)
  const origin = vi.fn(async () => 'other')
  expect(await withCache('deferred', false, origin)).toEqual({ value: 'value', status: 'hit' })
  expect(origin).not.toHaveBeenCalled()
  release()
  await deferred[0]
  expect(store.size).toBe(1)
})
