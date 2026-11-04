import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { waitUntil } from '@vercel/functions'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
// A low front-door quota so the test can exhaust it in a handful of requests.
vi.mock('./quotas.js', async original => {
  const actual = await original<typeof import('./quotas.js')>()
  return { ...actual, API_IP: { ...actual.API_IP, quota: 5 } }
})

import handler from '../api/notfound.js'
import { resetRateLimits } from './ratelimit.js'

const fetchMock = vi.fn()

function exchange(path: string, accept = 'application/json') {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'
  req.url = `/api/notfound?path=${path}`
  req.query = { path }
  req.headers = { host: 'mdfromx.com', 'x-forwarded-proto': 'https', accept, 'x-real-ip': '192.0.2.77' }
  const res = new ServerResponse(req) as VercelResponse
  let body: string | undefined
  res.status = code => { res.statusCode = code; return res }
  res.send = value => { body = String(value); res.emit('finish'); return res }
  res.json = value => { body = JSON.stringify(value); res.emit('finish'); return res }
  res.end = (() => { res.emit('finish'); return res }) as VercelResponse['end']
  return { req, res, body: () => body }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetRateLimits()
  vi.stubEnv('KV_REST_API_URL', '')
  vi.stubEnv('KV_REST_API_TOKEN', '')
  vi.stubEnv('UPSTASH_REDIS_REST_URL', '')
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', '')
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test')
  vi.stubEnv('POSTHOG_HOST', 'https://eu.i.posthog.com')
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('unknown-path 404 abuse', () => {
  test('misses spend the api-ip front door and are refused with 429 past it', async () => {
    const statuses: number[] = []
    let first: ReturnType<typeof exchange> | undefined
    let last: ReturnType<typeof exchange> | undefined
    for (let n = 1; n <= 10; n++) {
      const call = exchange(`/zz${n}`)
      await handler(call.req, call.res)
      statuses.push(call.res.statusCode)
      first ??= call
      last = call
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404, 429, 429, 429, 429, 429])
    expect(Number(last!.res.getHeader('Retry-After'))).toBeGreaterThan(0)
    expect(last!.res.getHeader('Cache-Control')).toBe('no-store')

    // The first miss still carries the negotiated recovery document.
    expect(first!.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(first!.body()!).code).toBe('route_not_found')
    expect(first!.res.getHeader('Vary')).toBe('Accept')
  })

  test('the 404 lets the CDN absorb repeats of the same path', async () => {
    const call = exchange('/zz-cache', 'text/markdown')
    await handler(call.req, call.res)
    expect(call.res.statusCode).toBe(404)
    const shared = String(call.res.getHeader('Vercel-CDN-Cache-Control') ?? call.res.getHeader('Cache-Control'))
    expect(Number(/s-maxage=(\d+)/.exec(shared)?.[1] ?? 0)).toBeGreaterThan(0)
    expect(String(call.res.getHeader('Cache-Control'))).toMatch(/s-maxage=[1-9]/)
  })

  test('a miss bills at most one analytics event', async () => {
    const random = vi.spyOn(Math, 'random')
    let events = 0
    for (const roll of [0, 0.5, 0.99]) {
      random.mockReturnValue(roll)
      const call = exchange(`/zz-analytics-${roll}`)
      await handler(call.req, call.res)
      for (const [promise] of vi.mocked(waitUntil).mock.calls) await promise
      vi.mocked(waitUntil).mockClear()
    }
    for (const [, init] of fetchMock.mock.calls) events += JSON.parse(init.body).batch.length
    for (const [, init] of fetchMock.mock.calls) {
      for (const event of JSON.parse(init.body).batch) {
        expect(event.event).toBe('request_completed')
        expect(event.properties.sample_rate).toBe(0.1)
      }
    }
    // Three misses, one sampled in: one event and one POST, not six and three.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(events).toBe(1)
  })
})
