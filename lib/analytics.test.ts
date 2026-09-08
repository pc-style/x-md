import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'
import {
  captureBatchBrowse,
  captureCacheLookup,
  captureFallback,
  captureMediaResolved,
  captureOEmbedRequested,
  captureRateLimit,
  captureSearchExecuted,
  captureUpstreamError,
  errorTypeFor,
  trackRequest,
} from './analytics.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))

const fetchMock = vi.fn()
function request(method = 'GET', url = '/search?q=private-search') {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = url
  req.headers = { authorization: 'Bearer private-token', 'x-real-ip': '192.0.2.55' }
  return { req, res: new ServerResponse(req) }
}
async function sent() {
  await Promise.all(vi.mocked(waitUntil).mock.calls.map(call => call[0]).filter(Boolean))
  return fetchMock.mock.calls.map(call => JSON.parse(call[1].body as string))
}
async function finish(res: ServerResponse) {
  res.emit('finish')
  res.emit('close')
  const events = await sent()
  return events.findLast(event => event.event === 'request_completed') ?? events.at(-1)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('POSTHOG_PROJECT_TOKEN', '')
  vi.stubEnv('POSTHOG_HOST', '')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_test')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://eu.i.posthog.com')
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('production request analytics', () => {
  test('sends allowlisted events after completion, without request details', async () => {
    const { req, res } = request()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    trackRequest(req, res, 'browse', 'search')
    expect(waitUntil).toHaveBeenCalledTimes(2)
    await vi.mocked(waitUntil).mock.calls[0][0]
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body as string).event)).toEqual(['endpoint_called'])
    res.statusCode = 429
    res.setHeader('X-Cache', 'BYPASS')
    res.setHeader('X-Search-Degraded', 'true')
    const event = await finish(res)
    res.emit('finish')
    expect(fetchMock.mock.calls[0][0]).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(timeout).toHaveBeenCalledWith(3000)
    expect(event.event).toBe('request_completed')
    expect(event.properties).toEqual({
      route: 'search', method: 'GET', status: 429, duration_ms: expect.any(Number),
      cache: 'bypass', access: 'public', key_status: 'anonymous', degraded: true,
      environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null,
    })
    const events = await sent()
    expect(events.map(item => item.event).sort()).toEqual(['endpoint_called', 'request_completed', 'request_failed'])
    expect(events.find(item => item.event === 'request_failed').properties).toMatchObject({
      route: 'search', status: 429, error_type: 'rate_limited', duration_ms: expect.any(Number), environment: 'production',
    })
    const serialized = JSON.stringify(events)
    for (const secret of ['private-search', 'private-token', '192.0.2.55']) expect(serialized).not.toContain(secret)
  })

  test.each(['preview', 'development', ''])('does not track %s', (environment) => {
    vi.stubEnv('VERCEL_ENV', environment)
    const { req, res } = request()
    trackRequest(req, res, 'convert')
    res.emit('finish')
    expect(waitUntil).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each(['NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'NEXT_PUBLIC_POSTHOG_HOST'])('needs %s', (variable) => {
    vi.stubEnv(variable, '')
    const { req, res } = request()
    trackRequest(req, res, 'convert')
    expect(waitUntil).not.toHaveBeenCalled()
  })

  test('ignores preflights and does not complete disconnected requests', async () => {
    const preflight = request('OPTIONS')
    trackRequest(preflight.req, preflight.res, 'browse')
    expect(waitUntil).not.toHaveBeenCalled()
    const { req, res } = request()
    trackRequest(req, res, 'browse')
    res.emit('close')
    res.emit('finish')
    const events = await sent()
    expect(events.map(event => event.event)).toEqual(['endpoint_called'])
    expect(res.listenerCount('finish')).toBe(0)
  })

  test('uses stable pseudonyms only for verified keys', async () => {
    const ids: string[] = []
    for (const status of ['valid', 'valid', 'invalid', 'unverified', 'anonymous', 'anonymous']) {
      const { req, res } = request()
      const identity = trackRequest(req, res, 'browse', 'profile')
      identity.keyId = 'internal-key-id'
      res.setHeader('X-Api-Key-Status', status)
      const event = await finish(res)
      expect(JSON.stringify(event)).not.toContain('internal-key-id')
      expect(event.properties.access).toBe(status === 'valid' ? 'key' : 'public')
      ids.push(event.distinct_id)
    }
    expect(ids[0]).toMatch(/^key:[a-f0-9]{64}$/)
    expect(ids[0]).toBe(ids[1])
    expect(new Set(ids.slice(2)).size).toBe(4)
    expect(ids.slice(2).every(id => id.startsWith('anonymous:'))).toBe(true)
  })

  test('normalizes unknown fields and supports server-only configuration', async () => {
    vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_override')
    vi.stubEnv('POSTHOG_HOST', 'https://us.i.posthog.com/')
    const { req, res } = request('PRIVATE-METHOD')
    trackRequest(req, res, 'browse', 'private-resource')
    res.setHeader('X-Cache', 'private-cache-value')
    res.setHeader('X-Api-Key-Status', 'private-status')
    const event = await finish(res)
    expect(fetchMock.mock.calls[0][0]).toBe('https://us.i.posthog.com/i/v0/e/')
    expect(event.api_key).toBe('phc_override')
    expect(event.properties).toMatchObject({ route: 'browse', method: 'OTHER', cache: 'unknown', key_status: 'anonymous' })
    expect(JSON.stringify(event)).not.toContain('private-')
  })

  test.each(['reject', 'timeout', 'http'])('isolates %s delivery failures from the response', async (failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    if (failure === 'http') fetchMock.mockResolvedValue(new Response('{}', { status: 503 }))
    else fetchMock.mockRejectedValue(failure === 'timeout' ? new DOMException('private-detail', 'TimeoutError') : new Error('private-detail'))
    const { req, res } = request('HEAD')
    trackRequest(req, res, 'oembed')
    res.statusCode = 200
    await finish(res)
    expect(res.statusCode).toBe(200)
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-detail')
  })
})

describe('named server events', () => {
  test('endpoint_called classifies permalink convert vs generic convert', async () => {
    const permalink = request('GET', '/api/convert?handle=alice&id=20&via=route&format=json&full=true&thread=off&replies=recent&nocache=true')
    trackRequest(permalink.req, permalink.res, 'convert')
    const generic = request('GET', '/api/convert?url=https://x.com/alice/status/20')
    trackRequest(generic.req, generic.res, 'convert')
    permalink.res.emit('finish'); permalink.res.emit('close')
    generic.res.emit('finish'); generic.res.emit('close')
    const events = (await sent()).filter(event => event.event === 'endpoint_called')
    expect(events[0].properties).toMatchObject({
      endpoint: 'status_convert', format: 'json', full: true, thread: 'off', replies: 'recent', nocache: true, has_handle: true, environment: 'production',
    })
    expect(events[1].properties).toMatchObject({
      endpoint: 'generic_convert', format: 'markdown', full: false, thread: 'full', replies: 'top', nocache: false, has_handle: false,
    })
    expect(JSON.stringify(events)).not.toContain('alice')
  })

  test('endpoint_called does not copy unbounded numeric thread values', async () => {
    const { req, res } = request('GET', '/api/convert?handle=alice&id=20&thread=1848330199730315645')
    trackRequest(req, res, 'convert')
    res.emit('finish'); res.emit('close')
    const event = (await sent()).find(item => item.event === 'endpoint_called')
    expect(event.properties.thread).toBe('full')
    expect(JSON.stringify(event)).not.toContain('1848330199730315645')
    expect(JSON.stringify(event)).not.toContain('alice')
  })

  test('endpoint_called names browse resources and the aggregate alias', async () => {
    const search = request('GET', '/search?q=hello')
    trackRequest(search.req, search.res, 'browse', 'search')
    const followers = request('GET', '/api/browse?resource=followers&handle=alice')
    trackRequest(followers.req, followers.res, 'browse', 'followers')
    search.res.emit('finish'); search.res.emit('close')
    followers.res.emit('finish'); followers.res.emit('close')
    const events = (await sent()).filter(event => event.event === 'endpoint_called')
    expect(events[0].properties.endpoint).toBe('search_browse')
    expect(events[1].properties.endpoint).toBe('api_browse')
    expect(events[1].properties.has_handle).toBe(true)
    expect(JSON.stringify(events)).not.toContain('alice')
  })

  test('request_failed maps catalog codes onto coarse error types', () => {
    expect(errorTypeFor('not_found', 404)).toBe('not_found')
    expect(errorTypeFor('syndication_empty', 404)).toBe('not_found')
    expect(errorTypeFor('invalid_url', 400)).toBe('validation_error')
    expect(errorTypeFor('invalid_body', 400)).toBe('parse_error')
    expect(errorTypeFor('rate_limited', 429)).toBe('rate_limited')
    expect(errorTypeFor('fxtwitter_error', 502)).toBe('upstream_error')
    expect(errorTypeFor('firecrawl_invalid', 502)).toBe('upstream_error')
    expect(errorTypeFor('internal_error', 500)).toBe('upstream_error')
    expect(errorTypeFor(undefined, 500)).toBe('upstream_error')
  })

  test('helper events stay structural and drop media URLs', async () => {
    const { req, res } = request('GET', '/alice/status/20')
    trackRequest(req, res, 'convert')
    captureCacheLookup('hit', 'status')
    captureCacheLookup('miss', 'profile')
    captureCacheLookup('bypass', 'search')
    captureUpstreamError({ provider: 'fxtwitter', errorType: 'timeout', upstreamStatus: null, durationMs: 12.4 })
    captureFallback({ primaryProvider: 'fxtwitter', fallbackProvider: 'syndication', reason: 'primary_timeout' })
    captureRateLimit('ip')
    captureSearchExecuted({ feedType: 'latest', hasQuery: true, resultCount: 3 })
    captureBatchBrowse({ resource: 'search', format: 'json', resultCount: 3, hasCursor: true })
    captureOEmbedRequested('Mozilla/5.0 (compatible; Discordbot/2.0)', 'json')
    captureMediaResolved([{
      media: {
        videos: [{ url: 'https://video.twimg.com/private-clip.mp4', variants: [{}, {}] }],
        photos: [{ }],
      },
    }])
    await finish(res)
    const events = await sent()
    const byName = Object.fromEntries(events.map(event => [event.event, event.properties]))
    expect(byName.cache_hit).toMatchObject({ route: 'convert', endpoint: 'generic_convert', cache_key_type: 'status', environment: 'production' })
    expect(byName.cache_miss).toMatchObject({ cache_key_type: 'profile' })
    expect(byName.cache_hit && byName.cache_miss).toBeTruthy()
    expect(events.some(event => event.event === 'cache_bypass')).toBe(false)
    expect(byName.upstream_error).toMatchObject({
      provider: 'fxtwitter', error_type: 'timeout', upstream_status: null, duration_ms: 12, route: 'convert',
    })
    expect(byName.fallback_used).toMatchObject({
      primary_provider: 'fxtwitter', fallback_provider: 'syndication', reason: 'primary_timeout', route: 'convert',
    })
    expect(byName.rate_limit_applied).toMatchObject({ limit_type: 'ip', route: 'convert' })
    expect(byName.search_executed).toMatchObject({ feed_type: 'latest', has_query: true, result_count: 3 })
    expect(byName.batch_browse_called).toMatchObject({ resource: 'search', format: 'json', result_count: 3, has_cursor: true })
    expect(byName.oEmbed_requested).toMatchObject({ requester_bot: 'Discordbot', format: 'json' })
    expect(byName.media_resolved).toMatchObject({
      media_type: 'mixed', variant_count: 2, has_direct_url: true, route: 'convert',
    })
    expect(JSON.stringify(events)).not.toContain('private-clip')
    expect(JSON.stringify(events)).not.toContain('twimg.com')
  })

  test('oEmbed requester_bot is null for ordinary clients', async () => {
    captureOEmbedRequested('Mozilla/5.0', 'xml')
    const events = await sent()
    expect(events.at(-1).properties).toMatchObject({ requester_bot: null, format: 'xml', environment: 'production' })
  })
})
