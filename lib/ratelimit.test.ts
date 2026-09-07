import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { clientIp, peekRateLimit, rateLimit, resetRateLimits } from './ratelimit.js'

beforeEach(() => {
  resetRateLimits()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-06T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('rateLimit (memory store)', () => {
  test('allows up to the limit, then blocks until the window rolls over', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const r = await rateLimit('k', 3, 60)
      expect(r).toMatchObject({ allowed: true, limit: 3, remaining: 3 - i })
    }
    const blocked = await rateLimit('k', 3, 60)
    expect(blocked).toMatchObject({ allowed: false, remaining: 0 })
    expect(blocked.retryAfter).toBeGreaterThan(0)
    expect(blocked.retryAfter).toBeLessThanOrEqual(60)
    vi.advanceTimersByTime(61_000)
    expect((await rateLimit('k', 3, 60)).allowed).toBe(true)
  })

  test('keys are independent', async () => {
    await rateLimit('a', 1, 60)
    expect((await rateLimit('a', 1, 60)).allowed).toBe(false)
    expect((await rateLimit('b', 1, 60)).allowed).toBe(true)
  })
})

describe('rateLimit (redis store)', () => {
  test('uses INCR+EXPIRE NX over the REST pipeline and reads the count', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
    vi.stubEnv('KV_REST_API_TOKEN', 'tok')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ result: 5 }, { result: 1 }]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await rateLimit('k', 4, 60)
    expect(r).toMatchObject({ allowed: false, remaining: 0 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://kv.example/pipeline')
    expect(init.headers.Authorization).toBe('Bearer tok')
    const body = JSON.parse(init.body)
    expect(body[0][0]).toBe('INCR')
    expect(body[0][1]).toMatch(/^rl:k:\d+$/)
    // Counters are kept for one extra window so peekRateLimit can read the previous one.
    expect(body[1]).toEqual(['EXPIRE', body[0][1], 121, 'NX'])
  })

  test('refunds a rejected hit when asked and can peek both windows', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
    vi.stubEnv('KV_REST_API_TOKEN', 'tok')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: 5 }, { result: 1 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: 4 }]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: ['7', null, '3', '0'] }]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await rateLimit('k', 4, 60, true, true)).allowed).toBe(false)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)[0][0]).toBe('DECR')
    const peek = await peekRateLimit(['a', 'b'], 60)
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)[0][0]).toBe('MGET')
    expect(peek).toEqual({ current: [7, 0], previous: [3, 0] })
  })

  test('fails open when the store errors', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
    vi.stubEnv('KV_REST_API_TOKEN', 'tok')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    expect((await rateLimit('k', 1, 60)).allowed).toBe(true)
    expect((await rateLimit('k', 1, 60, true)).allowed).toBe(false)
  })
})

describe('clientIp', () => {
  test('prefers x-real-ip, then first x-forwarded-for hop', () => {
    expect(clientIp({ 'x-real-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2' })).toBe('1.1.1.1')
    expect(clientIp({ 'x-forwarded-for': '3.3.3.3, 10.0.0.1' })).toBe('3.3.3.3')
    expect(clientIp({ 'x-forwarded-for': ['4.4.4.4'] })).toBe('4.4.4.4')
    expect(clientIp({})).toBe('unknown')
  })
})
