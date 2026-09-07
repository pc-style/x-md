import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'
import { buildArchiveEvents, captureArchive, MAX_ARCHIVE_EVENT_BYTES, type ArchiveInput } from './archive.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
const fetchMock = vi.fn()
const input: ArchiveInput = { resource: 'tweet', source: 'fxtwitter', cache: 'hit', posts: [{ id: '123', text: 'public post', author: { id: '1', screen_name: 'user' } }] }
const options = { token: 'phc_test', distinctId: 'anonymous:test', requestId: 'c48b54a6-6466-4f92-8b8c-ff9c7e59e202', capturedAt: '2026-09-07T00:00:00.000Z' }
function request(method = 'GET') {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = '/search?q=private-query'
  req.headers = { authorization: 'Bearer private-token', 'x-real-ip': '192.0.2.44' }
  return { req, res: new ServerResponse(req) }
}
async function finish(res: ServerResponse) {
  res.emit('finish'); res.emit('close')
  await Promise.all(vi.mocked(waitUntil).mock.calls.map(call => call[0]))
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('XMD_ARCHIVE_ENABLED', 'true')
  vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test'); vi.stubEnv('POSTHOG_HOST', 'https://eu.i.posthog.com')
  vi.stubEnv('XMD_ARCHIVE_ACTOR_SECRET', 'secret-with-at-least-thirty-two-characters')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

test('v1 archive preserves useful structured records, never response/request fields', () => {
  const [event] = buildArchiveEvents({ ...input, markdown: 'private-markdown', body: 'private-body', query: 'private-query',
    warnings: ['private-warning'], posts: [{ ...input.posts![0], private_field: 'private-content',
      url: 'https://x.com/user/status/123?secret=private-url',
      author: { id: '1', screen_name: 'user', email: 'private-email', website: { url: 'https://a:b@example.com', private: 'private-website' } },
      media: { photos: [{ url: 'https://pbs.twimg.com/media/image', width: 200, private: 'private-media' }] },
      article: { title: 'Public article', content: { blocks: [{ text: 'full article', private: 'private-article' }] } },
      community_note: { token: 'private-note' },
    }] } as any, options)
  expect(event).toMatchObject({ event: 'xmd_data_captured', distinct_id: options.distinctId, properties: {
    archive_schema_version: 1, request_id: options.requestId, captured_at: options.capturedAt,
    http_status: 200, resource: 'tweet', source: 'fxtwitter', cache: 'hit', degraded: false,
    chunk_count: 1, chunk_index: 0, payload: { posts: [{ text: 'public post', url: 'https://x.com/user/status/123',
      article: { content: { blocks: [{ text: 'full article' }] } } }], users: [] }, warnings: ['source_result_warning'],
  } })
  expect(JSON.stringify(event)).not.toContain('private-')
  expect(JSON.stringify(event)).not.toContain('markdown')
})

test('filters protected data, including nested quotes and entire protected profile timelines', () => {
  const [event] = buildArchiveEvents({ ...input, posts: [
    { id: 'private', text: 'private', author: { protected: true } },
    { ...input.posts![0], quote: { id: 'hidden', text: 'private', author: { protected: true } } },
  ], users: [{ id: 'private', protected: true }, { id: 'public' }] }, options)
  expect(event.properties.payload.posts).toHaveLength(1)
  expect(event.properties.payload.posts[0].quote).toBeUndefined()
  expect(event.properties.payload.users).toEqual([{ id: 'public' }])
  expect(buildArchiveEvents({ ...input, profile: { id: 'private', protected: true } }, options)).toEqual([])
  expect(buildArchiveEvents({ ...input, posts: [{ id: 'empty' }, {}], users: [{}] }, options)).toEqual([])
})

test.each(['profile', 'search', 'followers', 'following'] as const)('captures useful %s results', resource => {
  const [event] = buildArchiveEvents({ resource, source: 'xsearch', degraded: true,
    users: [{ id: 'user1', screen_name: 'name' }], ...(resource === 'profile' ? { profile: { id: 'profile1' } } : {}) }, options)
  expect(event.properties.resource).toBe(resource)
  expect(event.properties.degraded).toBe(true)
  expect(event.properties.payload.users).toHaveLength(1)
  expect(event.properties.payload.profile?.id).toBe(resource === 'profile' ? 'profile1' : undefined)
})

test('chunks complete UTF-8 envelopes below limit, each record exactly once with stable request identity', () => {
  const posts = Array.from({ length: 8 }, (_, i) => ({ id: String(i), text: '🦋'.repeat(20_000) }))
  const events = buildArchiveEvents({ ...input, posts, profile: { id: 'profile' }, users: [{ id: 'user' }] }, options)
  expect(events.length).toBeGreaterThan(1)
  expect(events.flatMap(event => event.properties.payload.posts)).toEqual(posts)
  expect(events.flatMap(event => event.properties.payload.users)).toEqual([{ id: 'user' }])
  expect(events.filter(event => event.properties.payload.profile)).toHaveLength(1)
  expect(new Set(events.map(event => event.uuid)).size).toBe(events.length)
  events.forEach((event, i) => {
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(MAX_ARCHIVE_EVENT_BYTES)
    expect(event.properties).toMatchObject({ request_id: options.requestId, chunk_index: i, chunk_count: events.length })
  })
})

test('oversized single records reject the entire archive rather than truncate', () => {
  expect(() => buildArchiveEvents({ ...input, posts: [...input.posts!, { id: 'large', text: 'x'.repeat(200_000) }] }, options)).toThrow('archive_record_oversized')
})

test.each([
  ['XMD_ARCHIVE_ENABLED', ''], ['XMD_ARCHIVE_ENABLED', 'false'], ['VERCEL_ENV', 'preview'],
  ['XMD_ARCHIVE_ACTOR_SECRET', 'short'], ['POSTHOG_HOST', 'http://example.test'],
])('safe defaults: no capture when %s=%s', (name, value) => {
  vi.stubEnv(name, value)
  const { req, res } = request(); captureArchive(req, res, input)
  expect(waitUntil).not.toHaveBeenCalled()
})

test.each(['HEAD', 'OPTIONS', 'POST'])('does not capture %s', method => {
  const { req, res } = request(method); captureArchive(req, res, input)
  expect(waitUntil).not.toHaveBeenCalled()
})

test.each([{ dnt: '1' }, { 'sec-gpc': '1' }, { 'x-xmd-archive-opt-out': '1' }, { cookie: '__Host-xmd_archive_optout=1' }])('respects opt-out %j', headers => {
  const { req, res } = request(); req.headers = headers; captureArchive(req, res, input)
  expect(waitUntil).not.toHaveBeenCalled()
})

test('only captures completed wire 200, includes cache hits, never captures close without finish', async () => {
  for (const status of [200, 206, 301, 400, 500]) {
    const { req, res } = request(); captureArchive(req, res, input); res.statusCode = status; await finish(res)
  }
  expect(fetchMock).toHaveBeenCalledOnce()
  const event = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(event.properties.cache).toBe('hit')
  expect(event.distinct_id).toBe(`anonymous:${event.properties.request_id}`)
  expect(JSON.stringify(event)).not.toMatch(/private-|192\.0\.2/)
  const { req, res } = request(); captureArchive(req, res, input); res.emit('close'); await finish(res)
  expect(fetchMock).toHaveBeenCalledOnce()
})

test('pseudonymous actors: verified keys, browser UUID cookies, invalid-cookie per-request fallback', async () => {
  const ids: string[] = []
  for (const cookie of ['__Host-xmd_actor=018e7421-7573-7d04-839c-d0b005ad88ae', '__Host-xmd_actor=018e7421-7573-7d04-839c-d0b005ad88ae', '__Host-xmd_actor=private-email', '__Host-xmd_actor=%broken']) {
    const { req, res } = request(); req.headers.cookie = cookie
    captureArchive(req, res, input); await finish(res)
    ids.push(JSON.parse(fetchMock.mock.calls.at(-1)![1].body).distinct_id)
  }
  expect(ids[0]).toMatch(/^browser:[a-f0-9]{64}$/); expect(ids[0]).toBe(ids[1]); expect(ids[2]).not.toBe(ids[3])
  const { req, res } = request(); res.setHeader('X-Api-Key-Status', 'valid')
  captureArchive(req, res, input, { keyId: 'private-key-id' }); await finish(res)
  const event = JSON.parse(fetchMock.mock.calls.at(-1)![1].body)
  expect(event.distinct_id).toMatch(/^key:[a-f0-9]{64}$/)
  expect(JSON.stringify(event)).not.toContain('private-key-id')
})

test.each(['http', 'network', 'oversized'])('isolates %s failures with honest non-sensitive logs', async failure => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  if (failure === 'http') fetchMock.mockResolvedValue(new Response('{}', { status: 503 }))
  if (failure === 'network') fetchMock.mockRejectedValue(new Error('private-error'))
  const { req, res } = request()
  captureArchive(req, res, failure === 'oversized' ? { ...input, posts: [{ id: '1', text: 'x'.repeat(200_000) }] } : input)
  await finish(res)
  expect(res.statusCode).toBe(200)
  expect(warn).toHaveBeenCalledOnce(); expect(JSON.stringify(warn.mock.calls)).not.toContain('private-')
  if (failure === 'oversized') expect(fetchMock).not.toHaveBeenCalled()
})


test('stops a multi-chunk delivery on rejection and does not retry or claim completeness', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    .mockResolvedValueOnce(new Response('{}', { status: 503 }))
  const { req, res } = request()
  captureArchive(req, res, { ...input, posts: Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: 'x'.repeat(100_000) })) })
  await finish(res)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(warn).toHaveBeenCalledWith('[archive] PostHog rejected a chunk; archive may be incomplete')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).properties.chunk_count).toBe(5)
  expect(res.statusCode).toBe(200)
})

test('unverified key IDs never establish a stable actor', async () => {
  const { req, res } = request(); res.setHeader('X-Api-Key-Status', 'unverified')
  captureArchive(req, res, input, { keyId: 'private-unverified-key' }); await finish(res)
  const event = JSON.parse(fetchMock.mock.calls.at(-1)![1].body)
  expect(event.distinct_id).toBe(`anonymous:${event.properties.request_id}`)
  expect(JSON.stringify(event)).not.toContain('private-')
})


test('rejects redirects so archive content cannot be replayed to another origin or HTTP', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  fetchMock.mockRejectedValue(new TypeError('redirect encountered'))
  const { req, res } = request()
  captureArchive(req, res, input); await finish(res)
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
  expect(warn).toHaveBeenCalledWith('[archive] delivery_or_serialization_failed; archive not guaranteed')
  expect(res.statusCode).toBe(200)
})
