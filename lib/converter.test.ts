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
import { convertTweet } from './converter.js'
import { ConvertError } from './errors.js'
import { buildCacheKey } from './cache.js'

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

  test('cache key uses version 2', async () => {
    await convertTweet({ url: validUrl, thread: 'full' })
    expect(mockedBuildCacheKey).toHaveBeenCalledWith(
      expect.objectContaining({ v: 2 }),
    )
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