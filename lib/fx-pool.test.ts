import { afterEach, describe, expect, test, vi } from 'vitest'

// The pool is read from the environment at import time, so set it before importing.
process.env.FXTWITTER_BASE_URL = 'https://fx-a.example, https://fx-b.example/, https://api.fxtwitter.com'
const { FX_BASES, FX_CONNECTIONS_HEDGE_MS, fetchFxConnections, fetchFxProfile, fetchFxProfileStatuses, pickFxBase, resetFxPool } = await import('./fxtwitter.js')

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

  test('a miss X confirmed on one base outranks another base failing first', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new URL(String(input)).host === 'fx-a.example'
      ? new Response('bad gateway', { status: 502 })
      : new Response(JSON.stringify({ code: 404, message: 'User not found', reason: 'not_found' }), { status: 404 })))
    await expect(fetchFxConnections('nobody', 'followers')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })

  test('a base failure before the hedge sends it at once; two bases missing the account is a 404', async () => {
    vi.useFakeTimers()
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      hosts.push(new URL(String(input)).host)
      return new Response(JSON.stringify({ code: 404, message: 'User not found' }), { status: 404 })
    }))
    await expect(fetchFxConnections('ada', 'followers')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS * 2)
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])

    resetFxPool()
    hosts.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      return host === 'fx-a.example' ? new Response('bad gateway', { status: 502 }) : new Response(JSON.stringify(users(2, 'b')), { status: 200 })
    }))
    expect((await fetchFxConnections('ada', 'following')).results).toHaveLength(2)
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])

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
    // Rotate past fx-a, then let fx-b throttle, which sends the hedge at once to
    // the public instance; it throttles too, and both sit out. The third base
    // is still healthy, so it is asked rather than reporting the throttle.
    expect(pickFxBase()).toBe('https://fx-a.example')
    const third = fetchFxConnections('ada', 'followers')
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await third).results[0]?.screen_name).toBe('slow1')
    expect(hosts).toEqual(['fx-b.example', 'api.fxtwitter.com', 'fx-a.example'])
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

describe('profile failover across the pool', () => {
  const user = () => new Response(JSON.stringify({ code: 200, user: { screen_name: 'ada' } }), { status: 200 })
  const missing = () => new Response(JSON.stringify({ code: 404, message: 'User not found' }), { status: 404 })

  test('a base answering 5xx or timing out moves the lookup to the next base instead of a 503', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      if (host === 'fx-a.example') return new Response('unavailable', { status: 503 })
      if (host === 'fx-b.example') throw new TypeError('fetch failed')
      return user()
    }))
    expect(await fetchFxProfile('ada')).toMatchObject({ screen_name: 'ada' })
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example', 'api.fxtwitter.com'])
    // Both failed bases sit out, so the next lookups skip them.
    hosts.length = 0
    await fetchFxProfile('ada')
    await fetchFxProfile('ada')
    expect(hosts).toEqual(['api.fxtwitter.com', 'api.fxtwitter.com'])
  })

  test('copies sharing an asked list start on a base none has asked, however far the rotation moved', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      hosts.push(new URL(String(input)).host)
      return user()
    }))
    const asked = ['https://fx-a.example', 'https://fx-b.example']
    // Other requests advance the shared rotation back round to fx-a.
    pickFxBase(); pickFxBase(); pickFxBase()
    await fetchFxProfile('ada', undefined, false, asked)
    expect(hosts).toEqual(['api.fxtwitter.com'])
    expect(asked).toEqual(['https://fx-a.example', 'https://fx-b.example', 'https://api.fxtwitter.com'])
  })

  test('one NOT_FOUND is retried on another base; a second base agreeing is a 404', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const { host } = new URL(String(input))
      hosts.push(host)
      return host === 'fx-a.example' ? missing() : user()
    }))
    expect(await fetchFxProfile('ada')).toMatchObject({ screen_name: 'ada' })
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])

    resetFxPool()
    hosts.length = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      hosts.push(new URL(String(input)).host)
      return missing()
    }))
    await expect(fetchFxProfile('nobody')).rejects.toMatchObject({ status: 404, code: 'not_found' })
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])
  })

  test('a provider failure on every base still surfaces as retryable, never as a 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    await expect(fetchFxProfile('ada')).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
