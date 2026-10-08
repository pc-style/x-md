import { afterEach, describe, expect, it, vi } from 'vitest'
import { Mdfromx, MdfromxError, type BrowseResponse } from '../src/index.js'

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>

function client(handler: Handler, options: ConstructorParameters<typeof Mdfromx>[0] = {}) {
  const calls: { url: URL, headers: Headers }[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, headers: new Headers(init?.headers) })
    return handler(url, init ?? {})
  })
  return { x: new Mdfromx({ apiKey: '', fetch, ...options }), calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const problem = (code: string, status: number, extra: Record<string, unknown> = {}) => json({
  type: `https://mdfromx.com/docs/reliability#${code}`,
  title: code,
  status,
  detail: `detail for ${code}`,
  instance: 'https://mdfromx.com/api/v1/x',
  code,
  resolution: 'retry',
  documentation_url: 'https://mdfromx.com/docs/reliability#errors',
  ...extra,
}, status, { 'content-type': 'application/problem+json' })

const page = (nextCursor?: string): BrowseResponse => ({
  resource: 'search', page: 1, limit: 20, source: 'xsearch', markdown: '', cache: 'miss', posts: [], ...(nextCursor ? { nextCursor } : {}),
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('requests', () => {
  it('reads a post by URL as JSON from mdfromx.com', async () => {
    const { x, calls } = client(() => json({ posts: [] }))
    await x.posts.get('https://x.com/jack/status/20', { thread: 'off', full: true })
    const { url, headers } = calls[0]
    expect(url.origin + url.pathname).toBe('https://mdfromx.com/api/v1/posts')
    expect(Object.fromEntries(url.searchParams)).toEqual({ url: 'https://x.com/jack/status/20', thread: 'off', full: 'true', format: 'json' })
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.has('authorization')).toBe(false)
  })

  it('pairs a bare post id with a handle, as the API requires', async () => {
    const { x, calls } = client(() => json({ posts: [] }))
    await x.posts.get('20')
    await x.posts.get({ handle: 'jack', id: '20' })
    expect(calls[0].url.searchParams.get('handle')).toBe('i')
    expect(calls[0].url.searchParams.get('id')).toBe('20')
    expect(calls[1].url.searchParams.get('handle')).toBe('jack')
  })

  it('maps camelCase options to wire names and drops SDK-only ones', async () => {
    const { x, calls } = client(() => json(page()))
    await x.search.get('bun lang:en', { requireLive: true, feed: 'top', limit: 5, signal: new AbortController().signal })
    await x.profiles.importPosts('jack', { maxPosts: 50, withReplies: false, since: undefined })
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ q: 'bun lang:en', require_live: 'true', feed: 'top', limit: '5', format: 'json' })
    expect(calls[1].url.pathname).toBe('/api/v1/profiles/jack/posts')
    expect(Object.fromEntries(calls[1].url.searchParams)).toEqual({ max_posts: '50', with_replies: 'false', format: 'json' })
  })

  it('asks for Markdown with format and Accept', async () => {
    const { x, calls } = client(() => new Response('# jack'))
    expect(await x.profiles.markdown('jack')).toBe('# jack')
    expect(calls[0].url.searchParams.get('format')).toBe('markdown')
    expect(calls[0].headers.get('accept')).toBe('text/markdown')
  })

  it('sends the API key, falling back to MDFROMX_API_KEY', async () => {
    const explicit = client(() => json(page()), { apiKey: 'xmd_explicit' })
    await explicit.x.search.get('a')
    expect(explicit.calls[0].headers.get('authorization')).toBe('Bearer xmd_explicit')

    vi.stubEnv('MDFROMX_API_KEY', 'xmd_env')
    const calls: Headers[] = []
    const x = new Mdfromx({ fetch: async (_input, init) => { calls.push(new Headers(init?.headers)); return json(page()) } })
    await x.search.get('a')
    expect(calls[0].get('authorization')).toBe('Bearer xmd_env')
  })

  it('honors a custom base URL', async () => {
    const { x, calls } = client(() => json(page()), { baseUrl: 'https://x.pcstyle.dev/' })
    await x.profiles.followers('jack')
    expect(calls[0].url.href.startsWith('https://x.pcstyle.dev/api/v1/profiles/jack/followers?')).toBe(true)
  })
})

describe('errors', () => {
  it('throws MdfromxError with the problem code', async () => {
    const { x } = client(() => problem('invalid_handle', 400))
    const error = await x.profiles.get('bad-handle').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MdfromxError)
    expect(error).toMatchObject({ status: 400, code: 'invalid_handle', message: 'detail for invalid_handle' })
    expect((error as MdfromxError).problem?.resolution).toBe('retry')
  })

  it('reads a Markdown 404 page as not_found', async () => {
    const { x } = client(() => new Response('# 404 Not Found', { status: 404, headers: { 'content-type': 'text/markdown' } }))
    await expect(x.profiles.markdown('nobody')).rejects.toMatchObject({ status: 404, code: 'not_found' })
  })
})

describe('retries', () => {
  it('retries a 429 after Retry-After and succeeds', async () => {
    let n = 0
    const { x, calls } = client(() => (n++ === 0 ? problem('rate_limited', 429, { retry_after: 1 }) : json(page())), { retry: { maxRetries: 2 } })
    vi.useFakeTimers()
    try {
      const pending = x.search.get('a')
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toMatchObject({ resource: 'search' })
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toHaveLength(2)
  })

  it('gives up after maxRetries', async () => {
    // No Retry-After: back off 1s, then 2s.
    const { x, calls } = client(() => problem('upstream_unavailable', 503), { retry: { maxRetries: 2 } })
    vi.useFakeTimers()
    try {
      const pending = x.search.get('a').catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await pending).toMatchObject({ status: 503 })
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toHaveLength(3)
  })

  it('does not wait longer than maxDelayMs, and never retries other statuses', async () => {
    const long = client(() => problem('rate_limited', 429, { retry_after: 900 }))
    await expect(long.x.search.get('a')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 900 })
    expect(long.calls).toHaveLength(1)

    const bad = client(() => problem('invalid_params', 400))
    await expect(bad.x.search.get('a')).rejects.toMatchObject({ code: 'invalid_params' })
    expect(bad.calls).toHaveLength(1)

    const off = client(() => problem('rate_limited', 429, { retry_after: 1 }), { retry: false })
    await expect(off.x.search.get('a')).rejects.toMatchObject({ code: 'rate_limited' })
    expect(off.calls).toHaveLength(1)
  })
})

describe('pagination', () => {
  it('follows nextCursor until it is absent', async () => {
    const cursors = ['c1', 'c2', undefined]
    const { x, calls } = client(() => json(page(cursors.shift())))
    const pages: BrowseResponse[] = []
    for await (const p of x.search.pages('a', { limit: 5 })) pages.push(p)
    expect(pages).toHaveLength(3)
    expect(calls.map(c => c.url.searchParams.get('cursor'))).toEqual([null, 'c1', 'c2'])
    expect(calls.every(c => c.url.searchParams.get('limit') === '5')).toBe(true)
  })

  it('stops at maxPages and on a repeated cursor', async () => {
    const capped = client(() => json(page('again')))
    let count = 0
    for await (const _ of capped.x.profiles.followersPages('jack', { maxPages: 5 })) count++
    // The second page repeats the cursor it was asked with, so iteration ends there.
    expect(count).toBe(2)

    const limited = client(() => json(page(`c${Math.random()}`)))
    count = 0
    for await (const _ of limited.x.profiles.pages('jack', { maxPages: 3 })) count++
    expect(count).toBe(3)
  })
})

describe('streamPosts', () => {
  const ndjson = (text: string, chunk = 7) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(text)
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk))
      controller.close()
    },
  }), { headers: { 'content-type': 'application/x-ndjson' } })

  it('yields posts then meta, across chunk boundaries', async () => {
    const body = '{"post":{"id":"1","text":"héllo"}}\n{"post":{"id":"2"}}\n\n{"meta":{"handle":"jack","count":2},"profile":{"screen_name":"jack"}}\n'
    const { x, calls } = client(() => ndjson(body))
    const events = []
    for await (const event of x.profiles.streamPosts('jack', { maxPosts: 2 })) events.push(event)
    expect(events).toEqual([
      { post: { id: '1', text: 'héllo' } },
      { post: { id: '2' } },
      { meta: { handle: 'jack', count: 2 }, profile: { screen_name: 'jack' } },
    ])
    expect(calls[0].url.searchParams.get('format')).toBe('ndjson')
    expect(calls[0].headers.get('accept')).toBe('application/x-ndjson')
  })

  it('throws when the walk fails part-way', async () => {
    const body = '{"post":{"id":"1"}}\n{"error":{"code":"upstream_error","status":502,"title":"Upstream failed","detail":"walk failed","streamed_posts":1}}\n'
    const { x } = client(() => ndjson(body))
    const seen: unknown[] = []
    const error = await (async () => {
      for await (const event of x.profiles.streamPosts('jack')) seen.push(event)
    })().catch((e: unknown) => e)
    expect(seen).toHaveLength(1)
    expect(error).toMatchObject({ code: 'upstream_error', status: 502, message: 'walk failed' })
    expect((error as MdfromxError).problem?.streamed_posts).toBe(1)
  })
})
