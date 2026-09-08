import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { beforeEach, afterEach, expect, test, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'
import convertHandler from '../api/convert.js'
import browseHandler from '../api/browse.js'
import { convertTweet, ConvertError } from './converter.js'
import { browse } from './browse.js'
import { resolveCaller } from './apiauth.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./converter.js', async importOriginal => ({ ...await importOriginal<any>(), convertTweet: vi.fn() }))
vi.mock('./browse.js', async importOriginal => ({ ...await importOriginal<any>(), browse: vi.fn() }))
vi.mock('./apiauth.js', async importOriginal => ({ ...await importOriginal<any>(), resolveCaller: vi.fn() }))
const fetchMock = vi.fn()
const posts = [{ id: '123', text: 'public result', author: { screen_name: 'user' } }]
function exchange(method = 'GET', resource = 'search') {
  const req = new IncomingMessage(new Socket()) as any
  req.method = method; req.query = { resource, q: 'private-query', handle: 'user', id: '123' }
  req.headers = { accept: 'application/json' }
  const res = new ServerResponse(req) as any
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = res.json = res.end = () => { res.emit('finish'); return res }
  return { req, res }
}
async function events() {
  await Promise.all(vi.mocked(waitUntil).mock.calls.map(call => call[0]))
  return fetchMock.mock.calls.map(call => JSON.parse(call[1].body))
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('XMD_ARCHIVE_ENABLED', 'true')
  vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test'); vi.stubEnv('POSTHOG_HOST', 'https://eu.i.posthog.com')
  vi.stubEnv('XMD_ARCHIVE_ACTOR_SECRET', 'secret-at-least-thirty-two-characters')
  vi.mocked(convertTweet).mockResolvedValue({ posts, body: 'private-rendered-markdown', warnings: [], canonicalUrl: 'https://x.com/user/status/123', format: 'json', postCount: 1, source: 'fxtwitter', cache: 'hit', compact: true })
  vi.mocked(browse).mockResolvedValue({ resource: 'search', posts, query: 'private-query', page: 1, limit: 20, source: 'xsearch', markdown: 'private-rendered-markdown', cache: 'hit' })
  vi.mocked(resolveCaller).mockResolvedValue({ caller: { kind: 'public' }, status: 'anonymous', ip: '192.0.2.1' })
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test.each([convertHandler, browseHandler])('real handler emits separate completed metadata and structured archive', async handler => {
  const { req, res } = exchange(); await handler(req, res)
  const sent = await events()
  expect(res.statusCode).toBe(200)
  expect(sent.map(event => event.event).sort()).toEqual(['endpoint_called', 'request_completed', 'xmd_data_captured'])
  expect(sent.find(event => event.event === 'request_completed').properties.payload).toBeUndefined()
  expect(sent.find(event => event.event === 'xmd_data_captured').properties.payload.posts).toEqual(posts)
  expect(JSON.stringify(sent)).not.toContain('private-')
  expect(res.getHeader('Set-Cookie')).toBeUndefined()
})

test.each([convertHandler, browseHandler])('HEAD only emits metadata, errors never archive', async handler => {
  const { req, res } = exchange('HEAD'); await handler(req, res)
  expect((await events()).map(event => event.event).sort()).toEqual(['endpoint_called', 'request_completed'])
  vi.mocked(convertTweet).mockRejectedValue(new ConvertError(404, 'not found', 'not_found'))
  vi.mocked(browse).mockRejectedValue(new ConvertError(404, 'not found', 'not_found'))
  const failure = exchange(); await handler(failure.req, failure.res)
  expect(failure.res.statusCode).toBe(404)
  expect((await events()).every(event => event.event === 'request_completed' || event.event === 'endpoint_called' || event.event === 'request_failed')).toBe(true)
})

test('invalid API key returns 401 without browsing or archive', async () => {
  vi.mocked(resolveCaller).mockResolvedValue({ caller: { kind: 'public' }, status: 'invalid', ip: '192.0.2.1' })
  const { req, res } = exchange(); await browseHandler(req, res)
  expect(res.statusCode).toBe(401); expect(browse).not.toHaveBeenCalled()
  expect((await events()).map(event => event.event).sort()).toEqual(['endpoint_called', 'request_completed', 'request_failed'])
})

test('verified key actor never enters public response or payload', async () => {
  vi.mocked(resolveCaller).mockResolvedValue({ caller: { kind: 'key', id: 'private-internal-key', limit: 10 }, status: 'valid', ip: '192.0.2.1' })
  const { req, res } = exchange(); await browseHandler(req, res)
  const archive = (await events()).find(event => event.event === 'xmd_data_captured')
  expect(archive.distinct_id).toMatch(/^key:[a-f0-9]{64}$/)
  expect(res.getHeader('Cache-Control')).toBe('private, no-store')
  expect(JSON.stringify(archive)).not.toContain('private-')
})
