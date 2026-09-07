import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'
import { trackRequest } from './analytics.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))

const fetchMock = vi.fn()
function request(method = 'GET') {
  const req = new IncomingMessage(new Socket())
  req.method = method
  req.url = '/search?q=private-search'
  req.headers = { authorization: 'Bearer private-token', 'x-real-ip': '192.0.2.55' }
  return { req, res: new ServerResponse(req) }
}
async function finish(res: ServerResponse) {
  res.emit('finish')
  res.emit('close')
  await vi.mocked(waitUntil).mock.calls.at(-1)?.[0]
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body)
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
  test('sends one allowlisted event after completion, without request details', async () => {
    const { req, res } = request()
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    trackRequest(req, res, 'browse', 'search')
    expect(waitUntil).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
    res.statusCode = 429
    res.setHeader('X-Cache', 'BYPASS')
    res.setHeader('X-Search-Degraded', 'true')
    const event = await finish(res)
    res.emit('finish')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(timeout).toHaveBeenCalledWith(3000)
    expect(event.event).toBe('request_completed')
    expect(event.properties).toEqual({
      route: 'search', method: 'GET', status: 429, duration_ms: expect.any(Number),
      cache: 'bypass', access: 'public', key_status: 'anonymous', degraded: true,
      environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null,
    })
    const serialized = JSON.stringify(event)
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

  test('ignores preflights and disconnected requests', async () => {
    const preflight = request('OPTIONS')
    trackRequest(preflight.req, preflight.res, 'browse')
    expect(waitUntil).not.toHaveBeenCalled()
    const { req, res } = request()
    trackRequest(req, res, 'browse')
    res.emit('close')
    res.emit('finish')
    await vi.mocked(waitUntil).mock.calls[0][0]
    expect(fetchMock).not.toHaveBeenCalled()
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
    expect(warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private-detail')
  })
})
