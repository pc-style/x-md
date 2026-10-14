import { afterEach, describe, expect, test, vi } from 'vitest'

// The pool is read from the environment at import time, so set it before importing.
process.env.FXTWITTER_BASE_URL = 'https://fx-a.example, https://fx-b.example/, https://api.fxtwitter.com'
const { FX_BASES, FX_CONNECTIONS_HEDGE_MS, fetchFxConnections, fetchFxProfileStatuses, pickFxBase, resetFxPool } = await import('./fxtwitter.js')

const page = (n: number) => ({ code: 200, results: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), text: 'x' })), cursor: { bottom: 'next' } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetFxPool()
})

const users = (n: number, prefix: string) => ({ code: 200, results: Array.from({ length: n }, (_, i) => ({ screen_name: `${prefix}${i + 1}` })), cursor: { bottom: 'next' } })

/** A fetch that answers after `delayMs` on the fake clock. */
function slowResponse(body: unknown, delayMs: number): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })), delayMs)
  })
}

describe('hedged connections pages', () => {
  test('a slow base is hedged on the next one after the delay, and the first good answer wins', async () => {
    vi.useFakeTimers()
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      return slowResponse(users(20, host === 'fx-a.example' ? 'slow' : 'fast'), host === 'fx-a.example' ? 5_000 : 100)
    }))
    const pending = fetchFxConnections('ada', 'followers', undefined, 20)
    await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS - 1)
    expect(hosts).toEqual(['fx-a.example'])
    await vi.advanceTimersByTimeAsync(1 + 100)
    const result = await pending
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])
    expect(result.results[0]?.screen_name).toBe('fast1')
    // The slow answer arriving later changes nothing.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(hosts).toHaveLength(2)
  })

  test('a fast answer never spends a second request', async () => {
    vi.useFakeTimers()
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      hosts.push(new URL(String(input)).host)
      return slowResponse(users(20, 'f'), 50)
    }))
    const pending = fetchFxConnections('ada', 'following')
    await vi.advanceTimersByTimeAsync(50)
    expect((await pending).results).toHaveLength(20)
    await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS * 2)
    expect(hosts).toEqual(['fx-a.example'])
  })

  test('a failure before the hedge is reported at once; after it, the hedge may still answer', async () => {
    vi.useFakeTimers()
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      hosts.push(new URL(String(input)).host)
      return new Response(JSON.stringify({ code: 404, message: 'User not found' }), { status: 404 })
    }))
    await expect(fetchFxConnections('ada', 'followers')).rejects.toMatchObject({ status: 503, code: 'upstream_unavailable' })
    await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS * 2)
    expect(hosts).toEqual(['fx-a.example'])

    resetFxPool()
    const late: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const { host } = new URL(String(input))
      late.push(host)
      if (host === 'fx-a.example') return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ code: 404, message: 'User not found' }), { status: 404 })), 1_000))
      return slowResponse(users(3, 'h'), 500)
    }))
    const pending = fetchFxConnections('ada', 'followers')
    await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS + 500)
    expect((await pending).results).toHaveLength(3)
    expect(late).toEqual(['fx-a.example', 'fx-b.example'])
  })

  test('the hedge never asks the base already in flight: with every other base cooling it does not fire', async () => {
    vi.useFakeTimers()
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      if (host === 'fx-a.example') return slowResponse(users(20, 'slow'), 5_000)
      return Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    }))
    // Rotate past fx-a, then let fx-b and the public instance throttle and sit out.
    expect(pickFxBase()).toBe('https://fx-a.example')
    await expect(fetchFxConnections('ada', 'followers')).rejects.toMatchObject({ code: 'upstream_rate_limited' })
    await expect(fetchFxConnections('ada', 'followers')).rejects.toMatchObject({ code: 'upstream_rate_limited' })
    expect(hosts).toEqual(['fx-b.example', 'api.fxtwitter.com'])
    hosts.length = 0
    const pending = fetchFxConnections('ada', 'followers')
    await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS * 3)
    expect(hosts).toEqual(['fx-a.example'])
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).results[0]?.screen_name).toBe('slow1')
    expect(hosts).toEqual(['fx-a.example'])
  })
})

describe('upstream pool', () => {
  test('parses the list and rotates across it', () => {
    expect(FX_BASES).toEqual(['https://fx-a.example', 'https://fx-b.example', 'https://api.fxtwitter.com'])
    expect([pickFxBase(), pickFxBase(), pickFxBase(), pickFxBase()]).toEqual(['https://fx-a.example', 'https://fx-b.example', 'https://api.fxtwitter.com', 'https://fx-a.example'])
  })

  test('a throttled base sits out and the page is retried at once on another', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      if (host === 'fx-a.example') return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
      return new Response(JSON.stringify(page(30)), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const result = await fetchFxProfileStatuses('ada', undefined, 100, { withReplies: true, retries: 2 })
    expect(result.results).toHaveLength(30)
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])
    // fx-a is cooling: the next picks skip it.
    expect([pickFxBase(), pickFxBase()]).toEqual(['https://api.fxtwitter.com', 'https://fx-b.example'])
  })

  test('a base answering 5xx (exhausted accounts) is sidelined the same way', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      if (host === 'fx-a.example') return new Response('{"code":500,"message":"All methods failed"}', { status: 500, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify(page(30)), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const result = await fetchFxProfileStatuses('ada', undefined, 100, { withReplies: true, retries: 2 })
    expect(result.results).toHaveLength(30)
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])
  })
})
