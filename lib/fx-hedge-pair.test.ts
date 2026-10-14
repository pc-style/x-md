import { afterEach, expect, test, vi } from 'vitest'

// Two bases: the smallest pool that can hedge, and the one where the rotation
// comes straight back to the base already asked once the other is cooling.
process.env.FXTWITTER_BASE_URL = 'https://fx-a.example,https://fx-b.example'
const { FX_CONNECTIONS_HEDGE_MS, fetchFxConnections, resetFxPool } = await import('./fxtwitter.js')

const users = (prefix: string) => ({ code: 200, results: Array.from({ length: 3 }, (_, i) => ({ screen_name: `${prefix}${i + 1}` })), cursor: { bottom: 'next' } })
const slowResponse = (body: unknown, delayMs: number) => new Promise<Response>((resolve) => {
  setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })), delayMs)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetFxPool()
})

test('with the other base cooling down, a slow page is waited out rather than asked twice of the same base', async () => {
  vi.useFakeTimers()
  const hosts: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: string | URL) => {
    const { host } = new URL(String(input))
    hosts.push(host)
    if (host === 'fx-b.example') return Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }))
    return slowResponse(users('slow'), 5_000)
  }))
  // fx-a answers slowly; its hedge lands on fx-b, which throttles and sits out.
  const throttled = fetchFxConnections('ada', 'followers')
  await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS + 5_000)
  expect((await throttled).results[0]?.screen_name).toBe('slow1')
  expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])
  hosts.length = 0
  // Only fx-a is left: the slow page is not doubled up on it.
  const pending = fetchFxConnections('ada', 'followers')
  await vi.advanceTimersByTimeAsync(FX_CONNECTIONS_HEDGE_MS * 3)
  expect(hosts).toEqual(['fx-a.example'])
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await pending).results[0]?.screen_name).toBe('slow1')
  expect(hosts).toEqual(['fx-a.example'])
})
