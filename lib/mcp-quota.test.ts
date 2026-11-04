import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./quotas.js', async (original) => {
  const actual = await original<typeof import('./quotas.js')>()
  return { ...actual, API_IP: { ...actual.API_IP, quota: 2 } }
})
vi.mock('./fxtwitter.js', () => ({
  FX_BASES: ['https://api.fxtwitter.com'],
  fetchFxProfile: vi.fn(),
  fetchFxProfileStatuses: vi.fn(),
  fetchFxConnections: vi.fn(),
  fetchFxConversationReplies: vi.fn(),
  searchFxStatuses: vi.fn(),
}))

import handler from '../api/mcp.js'
import { resetMemoryCache } from './cache.js'
import { fetchFxProfile, fetchFxProfileStatuses } from './fxtwitter.js'
import { resetRateLimits } from './ratelimit.js'

function post(body: unknown, ip: string) {
  const req = new IncomingMessage(new Socket()) as never as Record<string, unknown>
  req.method = 'POST'
  req.query = {}
  req.headers = { accept: 'application/json', 'x-real-ip': ip }
  req.body = body
  const chunks: string[] = []
  const res = new ServerResponse(req as never) as never as Record<string, unknown> & { statusCode: number; getHeader(name: string): unknown }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = (payload?: unknown) => { if (payload !== undefined) chunks.push(String(payload)); return res }
  res.write = (chunk: unknown) => { chunks.push(String(chunk)); return true }
  res.end = () => res
  return (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res).then(() => ({ res, json: JSON.parse(chunks.join('')) }))
}

const profileCall = (id: number, handle: string, ip: string) =>
  post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'x_md_get_profile', arguments: { handle } } }, ip)

beforeEach(() => {
  // Hot memory only, so a previous run's disk entries cannot turn a miss into a hit.
  vi.stubEnv('CACHE_PERSIST', '0')
  resetRateLimits()
  resetMemoryCache()
  vi.mocked(fetchFxProfile).mockReset().mockImplementation(async (handle: string) => ({ screen_name: handle, name: handle }) as never)
  vi.mocked(fetchFxProfileStatuses).mockReset().mockResolvedValue({ results: [], cursor: {} } as never)
})

describe('/mcp tools/call spends the api-ip allowance', () => {
  test('distinct handles are refused once the allowance is spent, before any upstream fetch', async () => {
    const first = await profileCall(1, 'quota_one', '203.0.113.7')
    const second = await profileCall(2, 'quota_two', '203.0.113.7')
    expect(first.json.result.isError).toBe(false)
    expect(second.json.result.isError).toBe(false)
    const calls = vi.mocked(fetchFxProfile).mock.calls.length

    const third = await profileCall(3, 'quota_three', '203.0.113.7')
    expect(third.res.statusCode).toBe(429)
    expect(Number(third.res.getHeader('Retry-After'))).toBeGreaterThan(0)
    expect(third.json.id).toBe(3)
    expect(third.json.error.data).toMatchObject({ status: 429, code: 'rate_limited', policy: 'api-ip' })
    expect(third.json.error.data.retryAfter).toBeGreaterThan(0)
    expect(vi.mocked(fetchFxProfile).mock.calls.length).toBe(calls)

    // Another address keeps its own allowance.
    expect((await profileCall(4, 'quota_three', '203.0.113.8')).json.result.isError).toBe(false)
  })

  test('cache hits for the same handle are free', async () => {
    for (let id = 1; id <= 4; id++) {
      const { res, json } = await profileCall(id, 'quota_same', '203.0.113.9')
      expect(res.statusCode, `call ${id}`).toBe(200)
      expect(json.result.isError, `call ${id}`).toBe(false)
    }
    expect(vi.mocked(fetchFxProfile)).toHaveBeenCalledTimes(1)
  })
})
