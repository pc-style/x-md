import { afterEach, describe, expect, test, vi } from 'vitest'

// The pool is read from the environment at import time, so set it before importing.
process.env.FXTWITTER_BASE_URL = 'https://fx-a.example, https://fx-b.example/, https://api.fxtwitter.com'
const { FX_BASES, fetchFxProfileStatuses, pickFxBase, resetFxPool } = await import('./fxtwitter.js')

const page = (n: number) => ({ code: 200, results: Array.from({ length: n }, (_, i) => ({ id: String(i + 1), text: 'x' })), cursor: { bottom: 'next' } })

afterEach(() => {
  vi.unstubAllGlobals()
  resetFxPool()
})

describe('upstream pool', () => {
  test('parses the list and rotates across it', () => {
    expect(FX_BASES).toEqual(['https://fx-a.example', 'https://fx-b.example', 'https://api.fxtwitter.com'])
    expect([pickFxBase(), pickFxBase(), pickFxBase(), pickFxBase()]).toEqual(['https://fx-a.example', 'https://fx-b.example', 'https://api.fxtwitter.com', 'https://fx-a.example'])
  })

  test('a throttled base sits out and the page is retried at once on another', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const url = String(input)
      hosts.push(new URL(url).host)
      if (url.startsWith('https://fx-a.example')) return new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })
      return new Response(JSON.stringify(page(30)), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    const result = await fetchFxProfileStatuses('ada', undefined, 100, { withReplies: true, retries: 2 })
    expect(result.results).toHaveLength(30)
    expect(hosts).toEqual(['fx-a.example', 'fx-b.example'])
    // fx-a is cooling: the next picks skip it.
    expect([pickFxBase(), pickFxBase()]).toEqual(['https://api.fxtwitter.com', 'https://fx-b.example'])
  })
})
