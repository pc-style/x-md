import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Connect, ViteDevServer } from 'vite'
import { afterEach, expect, test, vi } from 'vitest'

vi.mock('../lib/ratelimit-headers', async (original) => {
  const actual = await original<typeof import('../lib/ratelimit-headers')>()
  return { ...actual, chargeRequestQuota: vi.fn(actual.chargeRequestQuota) }
})
vi.mock('../lib/converter', async (original) => {
  const actual = await original<typeof import('../lib/converter')>()
  return { ...actual, convertTweet: vi.fn(actual.convertTweet) }
})
vi.mock('../lib/browse', async (original) => {
  const actual = await original<typeof import('../lib/browse')>()
  return { ...actual, browse: vi.fn(actual.browse) }
})
vi.mock('../lib/apiauth', async (original) => {
  const actual = await original<typeof import('../lib/apiauth')>()
  return { ...actual, resolveCaller: vi.fn(actual.resolveCaller) }
})

import { resolveCaller } from '../lib/apiauth'
import { browse } from '../lib/browse'
import { convertTweet } from '../lib/converter'
import { chargeRequestQuota } from '../lib/ratelimit-headers'
import { rateLimit } from '../lib/ratelimit'
import { SEARCH_IP, searchIpKey } from '../lib/quotas'
import { apiDevPlugin } from './vite-api-plugin'

afterEach(() => { vi.unstubAllEnvs(); vi.mocked(convertTweet).mockClear(); vi.mocked(browse).mockClear() })

/** One request through the dev middleware, answered or passed on. */
async function request(path: string, headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = path
  req.headers = { host: 'localhost:5173', ...headers }
  const res = new ServerResponse(req)
  let body = ''
  res.write = ((chunk: unknown) => { body += String(chunk); return true }) as typeof res.write
  const done = new Promise<void>((resolve) => {
    res.end = ((chunk?: unknown) => { if (chunk !== undefined) body += String(chunk); resolve(); return res }) as typeof res.end
  })
  const passed = new Promise<void>((resolve) => { middleware()(req, res, () => resolve()) })
  await Promise.race([done, passed])
  return { status: res.statusCode, header: (name: string) => res.getHeader(name), body }
}

const POST = { posts: [{ id: '20', text: 'fixture', author: { screen_name: 'jack', name: 'jack' } }], body: 'fixture', warnings: [], canonicalUrl: 'https://x.com/jack/status/20', format: 'markdown' as const, postCount: 1, source: 'fxtwitter' as const, cache: 'miss' as const, compact: true }

/** The connect middleware the plugin installs on the dev server. */
function middleware(): Connect.NextHandleFunction {
  let installed: Connect.NextHandleFunction | undefined
  const server = { middlewares: { use: (fn: Connect.NextHandleFunction) => { installed = fn } } } as unknown as ViteDevServer
  const configure = apiDevPlugin().configureServer as (server: ViteDevServer) => void
  configure(server)
  if (!installed) throw new Error('the plugin installed no middleware')
  return installed
}

test('a charge that fails while browse is rejecting the input is not an unhandled rejection', async () => {
  const rejections: unknown[] = []
  const listeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason) => { rejections.push(reason) })
  try {
    const failure = new Error('store unreachable')
    // The verdict fails only after browse has already rejected `limit`, before it awaited the verdict.
    vi.mocked(chargeRequestQuota).mockReturnValueOnce(new Promise((_resolve, reject) => setTimeout(() => reject(failure), 0)))
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'
    req.url = '/api/browse?resource=followers&handle=ada&limit=0'
    req.headers = { host: 'localhost:5173', accept: 'text/markdown' }
    const res = new ServerResponse(req)
    const passed = new Promise<unknown>((resolve) => { middleware()(req, res, resolve) })
    expect(await passed).toBe(failure)
    // Node reports an orphaned rejection only once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const listener of listeners) process.on('unhandledRejection', listener)
  }
  expect(rejections).toEqual([])
})

test('private mode gates the dev post and search readers, as production does', async () => {
  vi.stubEnv('X_MD_REQUIRE_API_KEY', '1')
  for (const path of ['/api/v1/posts?url=https://x.com/jack/status/20&format=json', '/jack/status/20?format=json', '/api/v1/search?q=audit&format=json']) {
    const response = await request(path, { accept: 'application/json', 'x-forwarded-for': '198.51.100.7' })
    expect(response.status, path).toBe(401)
    expect(JSON.parse(response.body).code, path).toBe('unauthorized')
  }
  expect(convertTweet).not.toHaveBeenCalled()
  expect(browse).not.toHaveBeenCalled()
  // The keyless Open Graph card stays exempt.
  vi.mocked(convertTweet).mockResolvedValueOnce(POST as never)
  const card = await request('/jack/status/20', { 'user-agent': 'Discordbot/2.0', accept: '*/*', 'x-forwarded-for': '198.51.100.7' })
  expect(card.status).toBe(200)
  expect(String(card.header('Content-Type'))).toContain('text/html')
})

test('a keyed dev conversion stays private, and a key that does not verify is refused', async () => {
  vi.mocked(convertTweet).mockResolvedValueOnce(POST as never)
  vi.mocked(resolveCaller).mockResolvedValueOnce({ caller: { kind: 'key', id: 'k1', limit: 100 }, status: 'valid', ip: '198.51.100.8' } as never)
  const keyed = await request('/api/v1/posts?url=https://x.com/jack/status/20', { authorization: 'Bearer good', 'x-forwarded-for': '198.51.100.8' })
  expect(keyed.status).toBe(200)
  expect(keyed.header('X-Api-Key-Status')).toBe('valid')
  expect(keyed.header('Cache-Control')).toBe('private, no-store')
  expect(keyed.header('Vercel-CDN-Cache-Control')).toBe('no-store')

  vi.mocked(resolveCaller).mockResolvedValueOnce({ caller: { kind: 'public', ip: '198.51.100.8' }, status: 'invalid', ip: '198.51.100.8' } as never)
  const invalid = await request('/api/v1/posts?url=https://x.com/jack/status/20', { authorization: 'Bearer nope', accept: 'application/json', 'x-forwarded-for': '198.51.100.8' })
  expect(invalid.status).toBe(401)
  expect(JSON.parse(invalid.body).code).toBe('invalid_key')
})

test('an uncached dev search reports the search it just spent', async () => {
  // Spends search-ip exactly where the real browse does (lib/browse.ts), then answers.
  vi.mocked(browse).mockImplementationOnce(async (input) => {
    await rateLimit(searchIpKey(input.ip ?? ''), SEARCH_IP.quota, SEARCH_IP.windowSec)
    return { resource: 'search', query: 'audit', page: 1, limit: 20, posts: [], source: 'xsearch', markdown: '', cache: 'miss' } as never
  })
  const response = await request('/api/v1/search?q=audit-settle&format=json', { 'x-forwarded-for': '198.51.100.9' })
  expect(response.status).toBe(200)
  // search-ip allows 5 a minute; this success already spent one of them.
  expect(String(response.header('RateLimit'))).toContain('"search-ip";r=4;')
})

test.each(['/api/v1/profiles/jack/posts?index=true', '/jack/posts?index=true', '/search/posts?index=true'])('dev serves bulk history at %s through api/import.ts', async (path) => {
  const response = await request(path, { accept: 'application/json', 'x-forwarded-for': '198.51.100.10' })
  expect(response.status).toBe(200)
  expect(JSON.parse(response.body)).toMatchObject({ handle: new URL(path, 'http://x').pathname.split('/').at(-2), archive: null })
})
