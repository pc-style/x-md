import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./fxtwitter.js', async original => {
  const actual = await original<typeof import('./fxtwitter.js')>()
  return { ...actual, fetchFxConnections: vi.fn(), searchFxStatuses: vi.fn() }
})
vi.mock('./ratelimit-headers.js', async original => {
  const actual = await original<typeof import('./ratelimit-headers.js')>()
  return { ...actual, chargeRequestQuota: vi.fn() }
})

import handler from '../api/browse.js'
import { resetMemoryCache } from './cache.js'
import { fetchFxConnections, searchFxStatuses } from './fxtwitter.js'
import { chargeRequestQuota, type RequestQuota } from './ratelimit-headers.js'
import { ACCOUNT_IP, SEARCH_IP, searchIpKey } from './quotas.js'
import { ConvertError } from './errors.js'
import { rateLimit, resetRateLimits } from './ratelimit.js'

const verdict = (allowed: boolean): RequestQuota => ({
  allowed,
  retryAfter: 7,
  states: [{ name: 'api-ip', quota: 600, windowSec: 60, partition: 'ip', remaining: allowed ? 599 : 0, resetSec: 7 }],
  degraded: false,
})

function exchange(query: Record<string, string>, accept = 'text/markdown') {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'
  req.url = '/api/browse'
  req.query = { ...query, via: 'route' }
  req.headers = { host: 'mdfromx.com', accept, 'x-real-ip': '192.0.2.1' }
  const res = new ServerResponse(req) as VercelResponse
  let body = ''
  res.status = code => { res.statusCode = code; return res }
  res.send = value => { body = String(value); res.emit('finish'); return res }
  return { req, res, body: () => body }
}

/**
 * The shared store behind the cache, as the Upstash REST pipeline: every command
 * is recorded, `GET` answers from `entries`, and `SET` can be held open forever
 * to show what does and does not wait for the durable write.
 */
function sharedStore(holdWrites = false) {
  const entries = new Map<string, string>()
  const commands: string[] = []
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'tok')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    if (!String(url).startsWith('https://kv.example/')) throw new Error(`unexpected fetch ${String(url)}`)
    const batch = JSON.parse(String(init.body)) as string[][]
    commands.push(...batch.map(command => command[0]!))
    if (holdWrites && batch.some(command => command[0] === 'SET')) await new Promise(() => {})
    return new Response(JSON.stringify(batch.map(([op, key, value]) => {
      if (op === 'SET') { entries.set(key!, value!); return { result: 'OK' } }
      return { result: entries.get(key!) ?? null }
    })), { status: 200 })
  }))
  return { commands, entries }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetMemoryCache()
  vi.stubEnv('CACHE_PERSIST', '0')
  vi.mocked(fetchFxConnections).mockResolvedValue({ results: [{ screen_name: 'bob', name: 'Bob' }] })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('the cache lookup overlaps the front-door charge, and a rejection answers 429 with no provider call or cache write', async () => {
  const { commands } = sharedStore()
  let decide!: (quota: RequestQuota) => void
  vi.mocked(chargeRequestQuota).mockReturnValueOnce(new Promise(resolve => { decide = resolve }))
  const { req, res, body } = exchange({ resource: 'followers', handle: 'ada' }, 'application/json')
  const answered = handler(req, res)
  // The lookup ran while the charge was still undecided; nothing deeper did.
  await vi.waitFor(() => expect(commands).toEqual(['GET']))
  expect(fetchFxConnections).not.toHaveBeenCalled()
  decide(verdict(false))
  await answered
  expect(res.statusCode).toBe(429)
  expect(JSON.parse(body()).code).toBe('rate_limited')
  expect(res.getHeader('Retry-After')).toBe('7')
  expect(res.getHeader('Cache-Control')).toBe('no-store')
  expect(fetchFxConnections).not.toHaveBeenCalled()
  expect(commands).toEqual(['GET'])
})

test('an admitted miss fetches upstream once and answers without waiting for the shared cache write', async () => {
  const { commands } = sharedStore(true)
  vi.mocked(chargeRequestQuota).mockResolvedValueOnce(verdict(true))
  const { req, res, body } = exchange({ resource: 'followers', handle: 'ada' })
  await handler(req, res)
  expect(res.statusCode).toBe(200)
  expect(res.getHeader('X-Cache')).toBe('MISS')
  expect(res.getHeader('RateLimit-Remaining')).toBe('599')
  expect(fetchFxConnections).toHaveBeenCalledTimes(1)
  // The write was issued and is still open, and the response did not wait for it.
  expect(commands).toEqual(['GET', 'SET'])
  expect(body()).toContain('(@bob)')
})

test('a cached result is served from the lookup alone once the charge allows it', async () => {
  const { commands, entries } = sharedStore()
  vi.mocked(chargeRequestQuota).mockResolvedValue(verdict(true))
  const warm = exchange({ resource: 'followers', handle: 'ada' })
  await handler(warm.req, warm.res)
  expect(warm.res.getHeader('X-Cache')).toBe('MISS')
  await vi.waitFor(() => expect(entries.size).toBe(1))
  // A fresh instance finds the entry another one stored.
  resetMemoryCache()
  const { req, res, body } = exchange({ resource: 'followers', handle: 'ada' })
  await handler(req, res)
  expect(res.statusCode).toBe(200)
  expect(res.getHeader('X-Cache')).toBe('HIT')
  expect(fetchFxConnections).toHaveBeenCalledTimes(1)
  expect(commands).toEqual(['GET', 'SET', 'GET'])
  expect(body()).toContain('(@bob)')
})

test('a charge that fails while browse is rejecting the input is not an unhandled rejection', async () => {
  const rejections: unknown[] = []
  const listeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', reason => { rejections.push(reason) })
  try {
    const failure = new Error('store unreachable')
    // The verdict fails only after browse has already rejected `limit`, before it awaited the verdict.
    vi.mocked(chargeRequestQuota).mockReturnValueOnce(new Promise((_resolve, reject) => setTimeout(() => reject(failure), 0)))
    const { req, res } = exchange({ resource: 'followers', handle: 'ada', limit: '0' })
    await expect(handler(req, res)).rejects.toBe(failure)
    // Node reports an orphaned rejection only once the microtask queue has drained.
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const listener of listeners) process.on('unhandledRejection', listener)
  }
  expect(rejections).toEqual([])
  expect(fetchFxConnections).not.toHaveBeenCalled()
})

test('an uncached search reports the search units it just spent', async () => {
  resetRateLimits()
  const actual = await vi.importActual<typeof import('./ratelimit-headers.js')>('./ratelimit-headers.js')
  vi.mocked(chargeRequestQuota).mockImplementation(actual.chargeRequestQuota)
  vi.mocked(searchFxStatuses).mockResolvedValue({ results: [{ id: '1', text: 'hi', url: 'https://x.com/ada/status/1', author: { screen_name: 'ada' } }] })
  const search = async (q: string) => {
    const { req, res } = exchange({ resource: 'search', q }, 'application/json')
    await handler(req, res)
    return res
  }
  const first = await search('hello')
  expect(first.statusCode).toBe(200)
  expect(String(first.getHeader('RateLimit'))).toContain(`"search-ip";r=${SEARCH_IP.quota - 1};`)
  // A cache hit spends nothing, so it reports the same position.
  const hit = await search('hello')
  expect(hit.getHeader('X-Cache')).toBe('HIT')
  expect(String(hit.getHeader('RateLimit'))).toContain(`"search-ip";r=${SEARCH_IP.quota - 1};`)
  for (let i = 2; i < SEARCH_IP.quota; i++) await search(`q${i}`)
  // The last allowed search says none are left, so a client pacing on `r` stops here instead of drawing a 429.
  const last = await search('last')
  expect(last.statusCode).toBe(200)
  expect(last.getHeader('RateLimit-Remaining')).toBe('0')
  expect((await search('over')).statusCode).toBe(429)
  vi.mocked(chargeRequestQuota).mockReset()
})

test('a search 429 raised below the handler reports that policy spent, timed like Retry-After', async () => {
  resetRateLimits()
  const actual = await vi.importActual<typeof import('./ratelimit-headers.js')>('./ratelimit-headers.js')
  vi.mocked(chargeRequestQuota).mockImplementation(actual.chargeRequestQuota)
  // The shared pool is spent while this caller still has search-ip quota left.
  vi.mocked(searchFxStatuses).mockRejectedValue(new ConvertError(429, 'Public search capacity is used up for this window.', 'rate_limited', 42, ACCOUNT_IP.name))
  const { req, res } = exchange({ resource: 'search', q: 'pool' }, 'application/json')
  await handler(req, res)
  expect(res.statusCode).toBe(429)
  expect(res.getHeader('Retry-After')).toBe('42')
  const rateLimit = String(res.getHeader('RateLimit'))
  expect(rateLimit).toContain(`"${ACCOUNT_IP.name}";r=0;t=42`)
  expect(rateLimit).toContain(`"search-ip";r=${SEARCH_IP.quota - 1};`)
  vi.mocked(chargeRequestQuota).mockReset()
})
