import { describe, test, expect, vi, beforeEach } from 'vitest'
import {
  getParentStatusId,
  fetchFxConversationChain,
  fetchFxFullThread,
  type FxTweet,
  type FxReplyingTo,
} from './fxtwitter.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTweet(id: string, overrides: Partial<FxTweet> = {}): FxTweet {
  return { id, text: `tweet ${id}`, ...overrides }
}

function fxStatusResponse(tweet: FxTweet) {
  return { code: 200, status: tweet }
}

function fxThreadResponse(thread: FxTweet[]) {
  return { code: 200, thread }
}

// ---------------------------------------------------------------------------
// getParentStatusId — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe('getParentStatusId', () => {
  test('returns status from object replying_to', () => {
    const tweet = makeTweet('200', {
      replying_to: { screen_name: 'alice', status: '100', url: 'https://x.com/alice/status/100' },
    })
    expect(getParentStatusId(tweet)).toBe('100')
  })

  test('skips array replying_to and falls back to replying_to_status', () => {
    const tweet = makeTweet('200', {
      replying_to: ['alice'],
      replying_to_status: ['100'],
    })
    expect(getParentStatusId(tweet)).toBe('100')
  })

  test('returns replying_to_status[0] when replying_to is null', () => {
    const tweet = makeTweet('200', {
      replying_to: null,
      replying_to_status: ['100'],
    })
    expect(getParentStatusId(tweet)).toBe('100')
  })

  test('returns replying_to_status[0] when replying_to is undefined', () => {
    const tweet = makeTweet('200', {
      replying_to_status: ['100'],
    })
    expect(getParentStatusId(tweet)).toBe('100')
  })

  test('returns undefined when both replying_to and replying_to_status are absent', () => {
    const tweet = makeTweet('100')
    expect(getParentStatusId(tweet)).toBeUndefined()
  })

  test('returns undefined when replying_to is object without status field', () => {
    const tweet = makeTweet('200', {
      replying_to: { screen_name: 'alice' } as FxReplyingTo,
    })
    expect(getParentStatusId(tweet)).toBeUndefined()
  })

  test('returns undefined when replying_to is empty array and replying_to_status is null', () => {
    const tweet = makeTweet('200', {
      replying_to: [],
      replying_to_status: null,
    })
    expect(getParentStatusId(tweet)).toBeUndefined()
  })

  test('prefers object replying_to.status over replying_to_status when both present', () => {
    const tweet = makeTweet('300', {
      replying_to: { status: '200' } as FxReplyingTo,
      replying_to_status: ['999'],
    })
    expect(getParentStatusId(tweet)).toBe('200')
  })

  test('coerces status value to string', () => {
    const tweet = makeTweet('300', {
      replying_to: { status: '42' } as FxReplyingTo,
    })
    expect(typeof getParentStatusId(tweet)).toBe('string')
    expect(getParentStatusId(tweet)).toBe('42')
  })

  test('returns status from replying_to_status when replying_to_status has no parent in replying_to object', () => {
    // replying_to object exists but has no .status field; fall through to replying_to_status
    const tweet = makeTweet('300', {
      replying_to: { screen_name: 'bob' } as FxReplyingTo,
      replying_to_status: ['50'],
    })
    expect(getParentStatusId(tweet)).toBe('50')
  })
})

// ---------------------------------------------------------------------------
// fetchFxConversationChain — mocks global fetch
// ---------------------------------------------------------------------------

describe('fetchFxConversationChain', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('returns single tweet in an array when it has no parent', async () => {
    const tweet = makeTweet('100')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
      ),
    )

    const result = await fetchFxConversationChain('100')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('100')
  })

  test('walks parent chain and returns in root-first order', async () => {
    const root = makeTweet('100')
    const mid = makeTweet('200', { replying_to: { status: '100' } as FxReplyingTo })
    const leaf = makeTweet('300', { replying_to: { status: '200' } as FxReplyingTo })
    const tweets: Record<string, FxTweet> = { '100': root, '200': mid, '300': leaf }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const id = Object.keys(tweets).find((k) => url.includes(`/status/${k}`))
        const tweet = id ? tweets[id] : root
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxConversationChain('300')
    expect(result.map((t) => t.id)).toEqual(['100', '200', '300'])
  })

  test('respects the limit parameter by slicing the root-first chain', async () => {
    const chain: Record<string, FxTweet> = {
      '100': makeTweet('100'),
      '200': makeTweet('200', { replying_to: { status: '100' } as FxReplyingTo }),
      '300': makeTweet('300', { replying_to: { status: '200' } as FxReplyingTo }),
      '400': makeTweet('400', { replying_to: { status: '300' } as FxReplyingTo }),
      '500': makeTweet('500', { replying_to: { status: '400' } as FxReplyingTo }),
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const id = Object.keys(chain).find((k) => url.includes(`/status/${k}`))
        const tweet = id ? chain[id] : chain['100']
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxConversationChain('500', 3)
    expect(result).toHaveLength(3)
    // Root-first chain [100,200,300,400,500], slice(0,3) = [100,200,300]
    expect(result.map((t) => t.id)).toEqual(['100', '200', '300'])
  })

  test('stops walking when a cycle is detected', async () => {
    const tweetA = makeTweet('100', { replying_to: { status: '200' } as FxReplyingTo })
    const tweetB = makeTweet('200', { replying_to: { status: '100' } as FxReplyingTo })
    let callCount = 0

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        callCount++
        const tweet = url.includes('/status/100') ? tweetA : tweetB
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxConversationChain('200')
    // Should break out of the cycle without infinite looping
    expect(result.length).toBeLessThanOrEqual(100)
    expect(callCount).toBeLessThanOrEqual(3)
  })

  test('uses replying_to_status fallback for parent resolution', async () => {
    const root = makeTweet('100')
    const leaf = makeTweet('200', { replying_to: ['alice'], replying_to_status: ['100'] })
    const tweets: Record<string, FxTweet> = { '100': root, '200': leaf }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const id = Object.keys(tweets).find((k) => url.includes(`/status/${k}`))
        const tweet = id ? tweets[id] : root
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxConversationChain('200')
    expect(result.map((t) => t.id)).toEqual(['100', '200'])
  })

  test('default limit is 100 — does not truncate a chain of 2', async () => {
    const root = makeTweet('1')
    const reply = makeTweet('2', { replying_to: { status: '1' } as FxReplyingTo })
    const tweets: Record<string, FxTweet> = { '1': root, '2': reply }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        const id = Object.keys(tweets).find((k) => url.endsWith(`/status/${k}`))
        const tweet = id ? tweets[id] : root
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxConversationChain('2')
    expect(result).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// fetchFxFullThread — mocks global fetch
// ---------------------------------------------------------------------------

describe('fetchFxFullThread', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('returns multi-tweet thread directly when thread endpoint returns >1 tweets', async () => {
    const tweets = [makeTweet('100'), makeTweet('200'), makeTweet('300')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxThreadResponse(tweets)), { status: 200 }),
      ),
    )

    const result = await fetchFxFullThread('300')
    expect(result.map((t) => t.id)).toEqual(['100', '200', '300'])
  })

  test('slices multi-tweet thread to the given limit', async () => {
    const tweets = [makeTweet('1'), makeTweet('2'), makeTweet('3'), makeTweet('4'), makeTweet('5')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxThreadResponse(tweets)), { status: 200 }),
      ),
    )

    const result = await fetchFxFullThread('5', 3)
    expect(result).toHaveLength(3)
    expect(result.map((t) => t.id)).toEqual(['1', '2', '3'])
  })

  test('returns single tweet directly when it has no parent', async () => {
    const tweet = makeTweet('100')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/thread/')) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 200, thread: [tweet] }), { status: 200 }),
          )
        }
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxFullThread('100')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('100')
  })

  test('falls back to conversation chain when thread endpoint returns single tweet with parent', async () => {
    const root = makeTweet('100')
    const leaf = makeTweet('200', { replying_to: { status: '100' } as FxReplyingTo })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/thread/')) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 200, thread: [leaf] }), { status: 200 }),
          )
        }
        if (url.includes('/status/100')) {
          return Promise.resolve(
            new Response(JSON.stringify(fxStatusResponse(root)), { status: 200 }),
          )
        }
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(leaf)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxFullThread('200')
    expect(result.map((t) => t.id)).toEqual(['100', '200'])
  })

  test('returns exactly limit posts when thread count equals limit', async () => {
    const tweets = [makeTweet('1'), makeTweet('2'), makeTweet('3')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxThreadResponse(tweets)), { status: 200 }),
      ),
    )

    const result = await fetchFxFullThread('3', 3)
    expect(result).toHaveLength(3)
  })

  test('does not slice when thread count is exactly equal to limit (no over-slicing)', async () => {
    const tweets = [makeTweet('A'), makeTweet('B')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxThreadResponse(tweets)), { status: 200 }),
      ),
    )

    const result = await fetchFxFullThread('B', 5)
    expect(result).toHaveLength(2)
  })

  test('returns [tweet] fallback when conversation chain result is empty (no-parent solo tweet)', async () => {
    // Thread endpoint returns single tweet with no parent -> no chain walk -> returns [tweet]
    const solo = makeTweet('300')

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) => {
        if (url.includes('/thread/')) {
          return Promise.resolve(
            new Response(JSON.stringify({ code: 200, thread: [solo] }), { status: 200 }),
          )
        }
        return Promise.resolve(
          new Response(JSON.stringify(fxStatusResponse(solo)), { status: 200 }),
        )
      }),
    )

    const result = await fetchFxFullThread('300')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('300')
  })
})