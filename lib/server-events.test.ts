import { fetchPosts } from './tweet-fetch.js'
import { fetchFxProfileStatuses, searchFxStatuses } from './fxtwitter.js'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'
import { withServerEvents, trackResult, trackRateLimit, providerFetch, reportProviderResponse, trackFallback, errorTypeFor } from './server-events.js'
import { problemDetails, sendProblem } from './apierror.js'
import { ConvertError } from './errors.js'
import { trackRequest } from './analytics.js'
import { withCache } from './cache.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
const sent: any[] = []
let upstream: () => Promise<Response>
function exchange(query: Record<string, string> = {}, method = 'GET', url = '/api/browse') {
  const req = new IncomingMessage(new Socket()) as any
  req.method = method; req.url = url; req.query = query
  req.headers = { accept: 'application/json', 'user-agent': 'Discordbot private-agent', 'x-real-ip': '192.0.2.55', authorization: 'Bearer private-token' }
  const res = new ServerResponse(req) as any
  return { req, res }
}
async function flush() { await Promise.all(vi.mocked(waitUntil).mock.calls.map(call => call[0])) }
function events(name: string) { return sent.filter(event => event.event === name).map(event => event.properties) }
beforeEach(() => {
  vi.clearAllMocks(); sent.length = 0
  vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test'); vi.stubEnv('POSTHOG_HOST', 'https://eu.i.posthog.com')
  vi.stubEnv('CACHE_PERSIST', 'false'); vi.stubEnv('CACHE_DISABLED', 'false')
  upstream = async () => new Response('{}')
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    if (String(url).startsWith('https://eu.i.posthog.com/')) { sent.push(JSON.parse(init.body)); return new Response('{}') }
    return upstream()
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

test.each([
  ['convert', { handle: 'private-handle', id: 'private-id' }, 'status_convert'],
  ['convert', { url: 'private-url' }, 'generic_convert'],
  ['browse', { resource: 'profile', via: 'route' }, 'profile_browse'],
  ['browse', { resource: 'search', via: 'route' }, 'search_browse'],
  ['browse', { resource: 'followers', via: 'route' }, 'followers_browse'],
  ['browse', { resource: 'following', via: 'route' }, 'following_browse'],
  ['browse', { resource: 'search' }, 'api_browse'],
  ['oembed', {}, 'oembed'],
] as const)('classifies %s %j before processing', async (kind, query, endpoint) => {
  const { req, res } = exchange({ ...query, thread: 'private-thread', replies: 'private-replies', full: 'true', nocache: '1', q: 'private-query' })
  await withServerEvents(kind, () => {
    expect(events('endpoint_called')).toHaveLength(1)
    res.emit('finish'); res.emit('finish'); res.emit('close')
  })(req, res)
  await flush()
  expect(events('endpoint_called')[0]).toMatchObject({ endpoint, format: 'json', thread: 'full', replies: 'top', full: true, nocache: true, has_handle: 'handle' in query })
  expect(JSON.stringify(sent)).not.toContain('private-')
  expect(JSON.stringify(sent)).not.toContain('192.0.2.55')
  for (const event of sent) {
    expect(event.distinct_id).toBe('server')
    expect(event.properties).toMatchObject({ environment: 'production', $geoip_disable: true, $process_person_profile: false })
  }
})

test('cache events occur at lookup, including a miss whose loader fails; bypass is neither', async () => {
  const { req, res } = exchange({ resource: 'profile', via: 'route' })
  await withServerEvents('browse', async () => {
    const key = crypto.randomUUID()
    await withCache(key, false, async () => 42)
    await withCache(key, false, async () => 99)
    await withCache(key, true, async () => 10)
    await expect(withCache(crypto.randomUUID(), false, async () => { throw new Error('private-error') })).rejects.toThrow()
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('cache_hit')).toEqual([expect.objectContaining({ route: 'profile', endpoint: 'profile_browse', cache_key_type: 'profile' })])
  expect(events('cache_miss')).toHaveLength(2)
})

test.each([400, 401, 404, 405, 429, 500, 502, 503])('records a completed %s once, even on routes without endpoint_called', async status => {
  const { req, res } = exchange()
  trackRequest(req, res, 'notfound')
  res.statusCode = status; res.emit('finish'); res.emit('finish'); res.emit('close')
  await flush()
  expect(events('request_failed')).toEqual([expect.objectContaining({ route: 'notfound', status, duration_ms: expect.any(Number) })])
  expect(events('request_failed')[0]).not.toHaveProperty('error_message')
})

test.each([
  ['http_error', 503, async () => new Response('bad', { status: 503 })],
  ['parse_failure', 200, async () => new Response('bad')],
  ['empty_response', 200, async () => new Response('{}')],
  ['http_error', 200, async () => new Response('{"success":false,"error":"private-error"}')],
  ['timeout', null, async () => { throw new DOMException('private-error', 'TimeoutError') }],
  ['network_error', null, async () => { throw new Error('private-error') }],
] as const)('tracks upstream %s without content and without duplicate JSON errors', async (kind, status, fetcher) => {
  upstream = fetcher
  const { req, res } = exchange()
  await withServerEvents('convert', async () => {
    try { const response = await providerFetch('fxtwitter', 'https://provider.invalid/private-id'); await response.json() } catch { /* expected */ }
    trackFallback('fxtwitter', 'syndication', 'primary_error')
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('upstream_error')).toEqual([expect.objectContaining({ provider: 'fxtwitter', route: 'convert', error_type: kind, upstream_status: status, duration_ms: expect.any(Number) })])
  expect(events('fallback_used')[0].reason).toBe(kind === 'timeout' ? 'primary_timeout' : kind === 'empty_response' ? 'primary_empty' : 'primary_error')
  expect(JSON.stringify(sent)).not.toContain('private-')
})

test('records semantic emptiness once with the real HTTP status', async () => {
  upstream = async () => new Response('{"markdown":""}')
  const { req, res } = exchange()
  await withServerEvents('convert', async () => {
    const response = await providerFetch('contextdev', 'https://provider.invalid')
    await response.json()
    reportProviderResponse(response, 'empty_response'); reportProviderResponse(response, 'empty_response')
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('upstream_error')).toHaveLength(1)
  expect(events('upstream_error')[0]).toMatchObject({ provider: 'contextdev', upstream_status: 200, error_type: 'empty_response' })
})

test('aggregate search includes result and cursor metadata; media deduplicates all and variants', async () => {
  const { req, res } = exchange({ resource: 'search', feed: 'media', q: 'private-query', cursor: 'private-cursor' })
  await withServerEvents('browse', () => {
    const video = { type: 'video', url: 'https://video.twimg.com/private.mp4', variants: [{ url: 'https://video.twimg.com/private.mp4' }], formats: [{ url: 'https://video.twimg.com/private.mp4' }] }
    trackResult({ posts: [{ media: { videos: [video], all: [video] }, quote: { media: { photos: [{ url: 'https://pbs.twimg.com/private.jpg' }] } } }] })
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('batch_browse_called')[0]).toMatchObject({ resource: 'search', format: 'json', result_count: 1, has_cursor: true })
  expect(events('search_executed')[0]).toMatchObject({ feed_type: 'photos', has_query: true, result_count: 1 })
  expect(events('media_resolved')[0]).toMatchObject({ media_type: 'mixed', variant_count: 1, has_direct_url: true })
  expect(JSON.stringify(sent)).not.toContain('private')
})

test.each(['Discordbot', 'Slackbot', 'TelegramBot', null])('oEmbed detects %s and records requested format', async bot => {
  const { req, res } = exchange({ format: 'xml' })
  req.headers['user-agent'] = bot?.toLowerCase() ?? 'unknown-private-agent'
  await withServerEvents('oembed', () => res.emit('finish'))(req, res)
  await flush()
  expect(events('oEmbed_requested')[0]).toMatchObject({ requester_bot: bot, format: 'xml' })
})

test('concurrent request contexts stay isolated and rate-limit types are structural', async () => {
  const a = exchange({ resource: 'search', via: 'route' })
  const b = exchange({ resource: 'followers', via: 'route' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const first = withServerEvents('browse', async () => { await gate; trackRateLimit('key'); a.res.emit('finish') })(a.req, a.res)
  await withServerEvents('browse', () => { trackRateLimit('global'); b.res.emit('finish'); release() })(b.req, b.res)
  await first; trackRateLimit('ip'); await flush()
  expect(events('rate_limit_applied').map(p => [p.route, p.limit_type])).toEqual([['followers', 'global'], ['search', 'key']])
})

test.each(['preview', 'development'])('does not send new events in %s', async environment => {
  vi.stubEnv('VERCEL_ENV', environment)
  const { req, res } = exchange()
  await withServerEvents('convert', () => { trackRateLimit('ip'); res.emit('finish') })(req, res)
  await flush(); expect(sent).toHaveLength(0)
})

test('disconnects keep arrival events but do not report results or failures', async () => {
  const { req, res } = exchange({ resource: 'search' })
  await withServerEvents('browse', () => { res.emit('close'); res.emit('finish') })(req, res)
  await flush()
  expect(sent.map(e => e.event)).toEqual(['endpoint_called'])
})


test('real provider fallback reports the failed primary and preserves the successful result', async () => {
  let calls = 0
  upstream = async () => ++calls === 1 ? new Response('{"code":500}') : new Response('{"id_str":"123","text":"private-text"}')
  const { req, res } = exchange()
  await withServerEvents('convert', async () => {
    const result = await fetchPosts('private-handle', '123', 'off')
    expect(result.source).toBe('syndication')
    expect(result.tweets[0].text).toBe('private-text')
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('upstream_error')).toHaveLength(1)
  expect(events('fallback_used')[0]).toMatchObject({ primary_provider: 'fxtwitter', fallback_provider: 'syndication', reason: 'primary_error' })
  expect(JSON.stringify(sent)).not.toContain('private-')
})

test('a valid empty provider list is not an upstream error; a missing list is', async () => {
  const { req, res } = exchange({ resource: 'profile', via: 'route' })
  await withServerEvents('browse', async () => {
    upstream = async () => new Response('{"results":[]}')
    expect((await fetchFxProfileStatuses('private-handle')).results).toEqual([])
    expect(events('upstream_error')).toHaveLength(0)
    upstream = async () => new Response('{"code":200}')
    await fetchFxProfileStatuses('private-handle')
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('upstream_error')).toHaveLength(1)
  expect(events('upstream_error')[0].error_type).toBe('parse_failure')
})

test.each(['GET', 'HEAD'])('image-only %s results never claim video variants', async method => {
  const { req, res } = exchange({}, method)
  await withServerEvents('convert', () => {
    trackResult({ posts: [{ media: { photos: [{ url: 'https://pbs.twimg.com/image.jpg' }] } }] })
    res.emit('finish')
  })(req, res)
  await flush()
  if (method === 'HEAD') expect(events('media_resolved')).toHaveLength(0)
  else expect(events('media_resolved')[0]).toMatchObject({ media_type: 'image', variant_count: 0, has_direct_url: false })
})

test('PostHog delivery failures do not fail the handler or expose error text', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private-message')))
  const { req, res } = exchange()
  await withServerEvents('convert', () => { res.emit('finish') })(req, res)
  await flush()
  expect(res.statusCode).toBe(200)
  expect(warn).toHaveBeenCalled()
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private-message')
})

test.each([
  ['HTTP 404 body', async () => new Response('{"code":404,"message":"NOT_FOUND"}', { status: 404 })],
  ['200 with not-found code', async () => new Response('{"code":404,"message":"NOT_FOUND"}')],
  ['private post', async () => new Response('{"code":401,"message":"PRIVATE_TWEET"}')],
])('a missing post (%s) is not an upstream error', async (_label, fetcher) => {
  // FxTwitter answers first; the syndication fallback sees a plain HTTP 404.
  let calls = 0
  upstream = async () => ++calls === 1 ? fetcher() : new Response('', { status: 404 })
  const { req, res } = exchange({ handle: 'private-handle', id: 'private-id' })
  await withServerEvents('convert', async () => {
    await expect(fetchPosts('private-handle', '123', 'off')).rejects.toMatchObject({ status: 404 })
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('upstream_error')).toHaveLength(0)
  expect(events('fallback_used')).toHaveLength(0)
})

test('an empty FxTwitter search timeline is still reported as an outage', async () => {
  upstream = async () => new Response('{"code":404,"results":[]}')
  const { req, res } = exchange({ resource: 'search', via: 'route' })
  await withServerEvents('browse', async () => {
    await expect(searchFxStatuses('private-query', 'latest')).rejects.toMatchObject({ code: 'search_unavailable' })
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('upstream_error')).toEqual([expect.objectContaining({ provider: 'fxtwitter', error_type: 'empty_response', upstream_status: 404 })])
})

test('fallback_used is not emitted when every provider fails', async () => {
  upstream = async () => new Response('{"code":500}', { status: 500 })
  const { req, res } = exchange()
  await withServerEvents('convert', async () => {
    await expect(fetchPosts('private-handle', '123', 'off')).rejects.toBeInstanceOf(ConvertError)
    res.emit('finish')
  })(req, res)
  await flush()
  expect(events('fallback_used')).toHaveLength(0)
  expect(events('upstream_error').length).toBeGreaterThanOrEqual(2)
})

test.each([
  ['invalid_url', 400, 'validation_error'],
  ['invalid_body', 400, 'parse_error'],
  ['invalid_key', 401, 'validation_error'],
  ['private_tweet', 404, 'not_found'],
  ['rate_limited', 429, 'rate_limited'],
  ['fxtwitter_error', 502, 'upstream_error'],
  ['search_unavailable', 503, 'upstream_error'],
  ['internal_error', 500, 'upstream_error'],
])('request_failed classifies %s from the catalog code', async (code, status, expected) => {
  expect(errorTypeFor(code, status)).toBe(expected)
  const { req, res } = exchange()
  res.status = (code: number) => { res.statusCode = code; return { send() {}, end() {} } }
  trackRequest(req, res, 'convert')
  sendProblem(res, problemDetails(code, { instance: '/x', status }), 'application/json')
  res.emit('finish'); res.emit('close')
  await flush()
  expect(events('request_failed')).toEqual([expect.objectContaining({ status, error_type: expected })])
})
