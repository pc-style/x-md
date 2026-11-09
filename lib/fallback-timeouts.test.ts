import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fetchContextDevStatus } from './contextdev.js'
import { fetchFirecrawlStatus, resetFirecrawlCooldown } from './firecrawl.js'
import { resetKv } from './kv.js'
import { UPSTREAM_CANCELLED } from './server-events.js'
import { fetchSyndicationStatus } from './syndication.js'

let server: Server
let respond = false
const nativeFetch = globalThis.fetch

beforeEach(async () => {
  vi.stubEnv('CONTEXT_DEV_API_KEY', 'test')
  vi.stubEnv('FIRECRAWL_API_KEY', 'test')
  vi.stubEnv('KV_REST_API_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  resetKv()
  await resetFirecrawlCooldown()
  respond = false
  server = createServer((req, res) => {
    req.resume()
    if (!respond) return
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      text: 'A real post', id_str: '123',
      success: true, markdown: 'A real post', data: { markdown: 'A real post' },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  // Replace only the upstream destination, not fetch or its abort handling.
  vi.stubGlobal('fetch', (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    nativeFetch(`http://127.0.0.1:${address.port}`, init))
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  resetKv()
})

test('stalled post fallbacks fail within their own ceilings', async () => {
  await Promise.all([
    [() => fetchSyndicationStatus('alice', '123'), 'syndication_network', 8_000],
    [() => fetchContextDevStatus('alice', '123'), 'contextdev_network', 12_000],
    [() => fetchFirecrawlStatus('alice', '123'), 'firecrawl_network', 15_000],
  ].map(async ([fetchPost, code, ceiling]: [() => Promise<unknown>, string, number]) => {
    const started = performance.now()
    await expect(fetchPost()).rejects.toMatchObject({ status: 502, code })
    const elapsed = performance.now() - started
    expect(elapsed).toBeGreaterThanOrEqual(ceiling - 100)
    expect(elapsed).toBeLessThan(ceiling + 2_000)
  }))
}, 18_000)

test('the syndication caller can still cancel before its own ceiling', async () => {
  const controller = new AbortController()
  const started = performance.now()
  const post = fetchSyndicationStatus('alice', '123', controller.signal)
  controller.abort(UPSTREAM_CANCELLED)
  await expect(post).rejects.toMatchObject({ status: 502, code: 'syndication_network' })
  expect(performance.now() - started).toBeLessThan(2_000)
})

test('responsive post fallbacks still return the post', async () => {
  respond = true
  const posts = await Promise.all([
    fetchSyndicationStatus('alice', '123'),
    fetchContextDevStatus('alice', '123'),
    fetchFirecrawlStatus('alice', '123'),
  ])
  for (const post of posts) expect(post).toMatchObject({ id: '123', text: 'A real post' })
})
