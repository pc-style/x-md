import { describe, test, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Module mocks — vi.mock() calls are hoisted before imports by vitest.
// converter.ts imports cache.js, tweet-fetch.js, and markdown.js internally.
// ---------------------------------------------------------------------------

vi.mock('./cache.js', () => ({
  buildCacheKey: vi.fn((args: Record<string, unknown>) => JSON.stringify(args)),
  withCache: vi.fn(async (_key: string, _nocache: boolean, fn: () => Promise<unknown>) => ({
    value: await fn(),
    status: 'miss',
  })),
  cacheControlHeader: vi.fn(() => 'public, max-age=300'),
  vercelCacheControlHeader: vi.fn(() => 'public, s-maxage=300'),
}))

vi.mock('./tweet-fetch.js', () => ({
  fetchPosts: vi.fn(async () => ({
    tweets: [{ id: '1', text: 'hello' }],
    source: 'fxtwitter',
  })),
}))

vi.mock('./markdown.js', () => ({
  renderThreadMarkdown: vi.fn(() => '# hello'),
}))

// Import after mocks are declared.
import { convertTweet, markdownResponse, parseStatusUrl } from './converter.js'
import { ConvertError } from './errors.js'
import { buildCacheKey } from './cache.js'
import { renderThreadMarkdown } from './markdown.js'
import { fetchPosts } from './tweet-fetch.js'

describe('output selection', () => {
  test.each(['x.pcstyle.dev', 'mdfromx.com'])('accepts permalinks from %s', (host) => {
    expect(parseStatusUrl(`https://${host}/jack/status/20`)).toEqual({
      handle: 'jack', id: '20', canonicalUrl: 'https://x.com/jack/status/20',
    })
  })
  const validUrl = 'https://x.com/testuser/status/1234567890'

  test('defaults to compact and full=true restores rich rendering', async () => {
    await convertTweet({ url: validUrl })
    expect(vi.mocked(renderThreadMarkdown)).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ compact: true }))
    await convertTweet({ url: validUrl, full: 'true' })
    expect(vi.mocked(renderThreadMarkdown)).toHaveBeenLastCalledWith(expect.any(Array), expect.objectContaining({ compact: false }))
  })

  test('format=json is accepted and JSON contains structured posts and metadata', async () => {
    const result = await convertTweet({ url: validUrl, format: 'json' })
    const response = markdownResponse(result, true)
    const payload = JSON.parse(response.body) as { posts: Array<{ id?: string; url?: string }>; source: string; markdown: string }
    expect(response.headers['Content-Type']).toContain('application/json')
    expect(payload.posts[0]).toMatchObject({ id: '1' })
    expect(payload.posts[0]?.url).toBe(validUrl)
    expect(payload.source).toBe('fxtwitter')
    expect(payload.markdown).toBe('# hello')
  })

  test('varies negotiated responses by Accept and separates browser and CDN caching', async () => {
    const result = await convertTweet({ url: validUrl })
    const response = markdownResponse(result)
    expect(response.headers).toMatchObject({
      Vary: 'Accept, User-Agent',
      'Cache-Control': 'public, max-age=300',
      'Vercel-CDN-Cache-Control': 'public, s-maxage=300',
    })
  })

  test('retains relation annotations and synthesizes reply source URLs', async () => {
    vi.mocked(fetchPosts).mockResolvedValueOnce({
      tweets: [{ id: '99', text: 'reply', context: 'reply', author: { screen_name: 'bob' } }],
      source: 'fxtwitter',
    })
    const result = await convertTweet({ url: validUrl, format: 'json' })
    expect(result.posts[0]).toMatchObject({
      id: '99', context: 'reply', url: 'https://x.com/bob/status/99',
    })
  })

  test('validates context and replies query values', async () => {
    await expect(convertTweet({ url: validUrl, context: 'bad' })).rejects.toMatchObject({ code: 'invalid_context' })
    await expect(convertTweet({ url: validUrl, replies: 'bad' })).rejects.toMatchObject({ code: 'invalid_replies' })
  })
})

// ---------------------------------------------------------------------------
// parseThread — error cases (throws before any fetch, no network needed)
// ---------------------------------------------------------------------------

describe('parseThread — invalid values throw ConvertError', () => {
  const validUrl = 'https://x.com/testuser/status/1234567890'

  test('throws for thread="1" (below minimum of 2)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '1' })).rejects.toBeInstanceOf(ConvertError)
  })

  test('throws for thread="101" (above maximum of 100)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '101' })).rejects.toBeInstanceOf(ConvertError)
  })

  test('throws for thread="0"', async () => {
    await expect(convertTweet({ url: validUrl, thread: '0' })).rejects.toBeInstanceOf(ConvertError)
  })

  test('throws for thread="-1" (negative number)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '-1' })).rejects.toBeInstanceOf(ConvertError)
  })

  test('throws for thread="abc" (non-numeric string)', async () => {
    await expect(convertTweet({ url: validUrl, thread: 'abc' })).rejects.toBeInstanceOf(ConvertError)
  })

  test('throws for thread="invalid_mode" (unrecognised alias)', async () => {
    await expect(
      convertTweet({ url: validUrl, thread: 'invalid_mode' }),
    ).rejects.toBeInstanceOf(ConvertError)
  })

  test('error message includes "conversation" as a valid option', async () => {
    let err: unknown
    try {
      await convertTweet({ url: validUrl, thread: 'bad' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConvertError)
    expect((err as ConvertError).message).toContain('conversation')
  })

  test('error code is "invalid_thread"', async () => {
    let err: unknown
    try {
      await convertTweet({ url: validUrl, thread: 'bad' })
    } catch (e) {
      err = e
    }
    expect((err as ConvertError).code).toBe('invalid_thread')
  })

  test('error status is 400', async () => {
    let err: unknown
    try {
      await convertTweet({ url: validUrl, thread: 'bad' })
    } catch (e) {
      err = e
    }
    expect((err as ConvertError).status).toBe(400)
  })

  // Regression: ensure the boundary values adjacent to valid range are rejected
  test('throws for thread="200" (well above maximum)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '200' })).rejects.toBeInstanceOf(ConvertError)
  })
})

// ---------------------------------------------------------------------------
// parseThread — valid values do not throw
// ---------------------------------------------------------------------------

describe('parseThread — valid values accepted', () => {
  const validUrl = 'https://x.com/testuser/status/1234567890'

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('thread=null resolves without error (defaults to full)', async () => {
    await expect(convertTweet({ url: validUrl, thread: null })).resolves.toBeDefined()
  })

  test('thread=undefined resolves without error (defaults to full)', async () => {
    await expect(convertTweet({ url: validUrl })).resolves.toBeDefined()
  })

  test('thread="full" resolves without error', async () => {
    await expect(convertTweet({ url: validUrl, thread: 'full' })).resolves.toBeDefined()
  })

  test('thread="conversation" resolves without error (new alias for full)', async () => {
    await expect(convertTweet({ url: validUrl, thread: 'conversation' })).resolves.toBeDefined()
  })

  test('thread="off" resolves without error', async () => {
    await expect(convertTweet({ url: validUrl, thread: 'off' })).resolves.toBeDefined()
  })

  test('thread="2" resolves without error (minimum numeric)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '2' })).resolves.toBeDefined()
  })

  test('thread="100" resolves without error (maximum numeric)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '100' })).resolves.toBeDefined()
  })

  test('thread="50" resolves without error (mid-range numeric)', async () => {
    await expect(convertTweet({ url: validUrl, thread: '50' })).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// canonicalThreadCacheValue — tested via the cache key built by convertTweet
// ---------------------------------------------------------------------------

describe('canonicalThreadCacheValue — cache key normalisation', () => {
  const validUrl = 'https://x.com/testuser/status/1234567890'
  const mockedBuildCacheKey = vi.mocked(buildCacheKey)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('thread=null produces a cache key with thread="full"', async () => {
    await convertTweet({ url: validUrl, thread: null })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'full' }),
    )
  })

  test('thread=undefined produces a cache key with thread="full"', async () => {
    await convertTweet({ url: validUrl })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'full' }),
    )
  })

  test('thread="full" produces a cache key with thread="full"', async () => {
    await convertTweet({ url: validUrl, thread: 'full' })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'full' }),
    )
  })

  test('thread="conversation" normalises to thread="full" in the cache key', async () => {
    await convertTweet({ url: validUrl, thread: 'conversation' })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'full' }),
    )
    // Ensure 'conversation' is NOT stored as-is
    const calls = mockedBuildCacheKey.mock.calls
    expect(calls.every((args) => (args[0] as { thread: string }).thread !== 'conversation')).toBe(true)
  })

  test('thread="off" stays as "off" in the cache key', async () => {
    await convertTweet({ url: validUrl, thread: 'off' })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ thread: 'off' }),
    )
  })

  test('numeric thread value is preserved in the cache key (e.g. "5")', async () => {
    await convertTweet({ url: validUrl, thread: '5' })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ thread: '5' }),
    )
  })

  test('cache key uses version 5, normalized handle, and includes post-context defaults', async () => {
    await convertTweet({ url: validUrl, thread: 'full' })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ v: 5, handle: 'testuser', context: 'full', replies: 'top' }),
    )
  })

  test('numeric limits preserve focal post and choose context by role before display ordering', async () => {
    vi.mocked(fetchPosts).mockResolvedValueOnce({ tweets: [
      { id: '1', context: 'parent' }, { id: '2', context: 'parent' },
      { id: '3', context: 'post' }, { id: '4', context: 'thread' },
      { id: '5', context: 'reply' },
    ], source: 'fxtwitter' })
    const result = await convertTweet({ url: 'https://x.com/TestUser/status/3', thread: '2', format: 'json' })
    expect(result.posts.map((post) => post.id)).toEqual(['2', '3'])
    expect(vi.mocked(buildCacheKey)).toHaveBeenLastCalledWith(expect.objectContaining({ handle: 'testuser' }))
  })

  // Regression: null and 'full' and 'conversation' all map to the same cache key
  test('thread=null, thread="full", and thread="conversation" all produce the same cache key', async () => {
    await convertTweet({ url: validUrl, thread: null })
    const keyFromNull = mockedBuildCacheKey.mock.calls[0]?.[0]

    vi.clearAllMocks()
    await convertTweet({ url: validUrl, thread: 'full' })
    const keyFromFull = mockedBuildCacheKey.mock.calls[0]?.[0]

    vi.clearAllMocks()
    await convertTweet({ url: validUrl, thread: 'conversation' })
    const keyFromConversation = mockedBuildCacheKey.mock.calls[0]?.[0]

    expect(keyFromNull).toEqual(keyFromFull)
    expect(keyFromFull).toEqual(keyFromConversation)
  })
})
