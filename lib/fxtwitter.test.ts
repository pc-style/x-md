import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getParentStatusId,
  fetchFxConversationChain,
  fetchFxFullThread,
  fetchFxThread,
  fetchFxConversationReplies,
  searchFxStatuses,
  fetchFxProfileStatuses,
  fetchFxProfile,
  fetchFxConnections,
  fetchFxStatus,
  resetFxPool,
  type FxTweet,
  type FxReplyingTo,
} from './fxtwitter.js'
import { fetchPosts } from './tweet-fetch.js'

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

describe('fetchFxProfileStatuses transient cursor misses', () => {
  beforeEach(() => vi.unstubAllGlobals())

  test('retries a timeline 404 at the same cursor and returns the recovered page', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND' }), { status: 404 }))
      .mockResolvedValue(new Response(JSON.stringify({ code: 200, results: Array.from({ length: 10 }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: 'next' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const page = await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4 })

    expect(page.results).toHaveLength(10)
    expect(page.attempts).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe(String(fetchMock.mock.calls[1][0]))
  })

  test('reports repeated timeline 404s as an upstream failure', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND' }), { status: 404 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 2 })).rejects.toMatchObject({
      status: 502,
      code: 'partial_upstream_failure',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  test('maps an ambiguous profile 404 to a retryable upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 404, message: 'User not found' }), { status: 404 })))
    await expect(fetchFxProfile('theo')).rejects.toMatchObject({ status: 503, code: 'upstream_unavailable', retryAfter: 30 })
  })

  test('maps a missing profile payload to a retryable upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 200, message: 'OK' }), { status: 200 })))
    await expect(fetchFxProfile('theo')).rejects.toMatchObject({ status: 503, code: 'upstream_unavailable' })
  })

  test('maps an ambiguous followers miss to a retryable upstream failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 404, message: 'User not found' }), { status: 404 })))
    await expect(fetchFxConnections('theo', 'followers')).rejects.toMatchObject({ status: 503, code: 'upstream_unavailable' })
  })

  test('a lone base is asked for a connections page once, however slow it is', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ code: 200, results: [{ screen_name: 'bob' }] }), { status: 200 })), 5_000)
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pending = fetchFxConnections('theo', 'followers')
    await vi.advanceTimersByTimeAsync(5_000)
    expect((await pending).results).toEqual([{ screen_name: 'bob' }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  test('keeps an explicit private post non-retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 404, message: 'PRIVATE_TWEET' }), { status: 404 })))
    const { fetchFxStatus } = await import('./fxtwitter.js')
    await expect(fetchFxStatus('20')).rejects.toMatchObject({ status: 404, code: 'private_tweet' })
  })

  test('hedged copies race and the first full page wins', async () => {
    let slowAnswered = false
    const page = (length: number, delay: number) => new Promise<Response>((resolve) => setTimeout(() => {
      if (delay >= 40) slowAnswered = true
      resolve(new Response(JSON.stringify({ code: 200, results: Array.from({ length }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: `b${length}` } }), { status: 200 }))
    }, delay))
    const fetchMock = vi.fn().mockImplementationOnce(() => page(1, 40)).mockImplementationOnce(() => page(10, 5))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge: 2 })
    expect(result.results).toHaveLength(10)
    expect(result.cursor?.bottom).toBe('b10')
    expect(result.attempts).toBe(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The full page won without waiting for the slow copy to answer.
    expect(slowAnswered).toBe(false)
  })

  test('every hedged copy keeps the retry budget and the page settles for the best short page', async () => {
    let n = 0
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ code: 200, results: Array.from({ length: n++ % 3 }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: 'b' } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge: 2 })
    // The first copy makes all five attempts; the second retries alongside it until it ends.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(9)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(10)
    expect(result.attempts).toBe(fetchMock.mock.calls.length)
    expect(result.results).toHaveLength(2)
  })

  test('a cursor that fails for a while fails a hedged page no sooner than a plain fetch', async () => {
    // NOT_FOUND for every request sent in the first 35 ms, each after 10 ms: a
    // plain fetch's fifth attempt goes out at 40 ms and gets the page, while
    // five attempts spent two at a time would all have gone out inside 35 ms.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      for (const hedge of [1, 2]) {
        const t0 = Date.now()
        const fetchMock = vi.fn().mockImplementation(() => {
          const failing = Date.now() - t0 < 35
          return new Promise<Response>((resolve) => setTimeout(() => resolve(failing
            ? new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND' }), { status: 404 })
            : new Response(JSON.stringify({ code: 200, results: Array.from({ length: 10 }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: 'b10' } }), { status: 200 })), 10))
        })
        vi.stubGlobal('fetch', fetchMock)
        const page = fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge })
        await vi.advanceTimersByTimeAsync(200)
        await expect(page).resolves.toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ id: '10' })]) })
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('a hedged copy that fails loses to one still in flight', async () => {
    const full = new Response(JSON.stringify({ code: 200, results: Array.from({ length: 10 }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: 'b10' } }), { status: 200 })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => setTimeout(() => resolve(full), 25)))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response('upstream down', { status: 500 })), 1)))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge: 2 })
    expect(result.results).toHaveLength(10)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('a malformed hedged copy loses to a good one', async () => {
    const full = new Response(JSON.stringify({ code: 200, results: Array.from({ length: 10 }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: 'b10' } }), { status: 200 })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => setTimeout(() => resolve(full), 25)))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ code: 200 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge: 2 })
    expect(result.results).toHaveLength(10)
  })

  test('a hedged page fails once every copy has, without retrying the error', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('upstream down', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge: 2 })).rejects.toMatchObject({ status: 503, code: 'upstream_unavailable' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('no second copy goes onto a base that is cooling down', async () => {
    resetFxPool()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '1' } }))
      .mockImplementation(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ code: 200, results: Array.from({ length: 10 }, (_, i) => makeTweet(String(i + 1))), cursor: { bottom: 'b10' } }), { status: 200 })), 20)))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchFxProfileStatuses('theo', 'cursor-0', 100)).rejects.toMatchObject({ code: 'upstream_rate_limited' })
    const result = await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 4, hedge: 2 })
    expect(result.results).toHaveLength(10)
    // One request once the cooldown is over; no duplicate waited it out alongside.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resetFxPool()
  })

  test('a gate sees every hedged copy', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ code: 200, results: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    let gated = 0
    await fetchFxProfileStatuses('theo', 'cursor-1', 100, { retries: 2, hedge: 2, gate: (request) => { gated += 1; return request() } })
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(gated).toBe(fetchMock.mock.calls.length)
  })

  test('does not claim an uncursored profile timeline miss proves deletion', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND' }), { status: 404 })))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchFxProfileStatuses('missing', undefined, 100, { retries: 4 })).rejects.toMatchObject({
      status: 503,
      code: 'upstream_unavailable',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  test('keeps the focal post in a long parent chain', async () => {
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

    const result = await fetchFxConversationChain('500')
    expect(result.map((t) => t.id)).toEqual(['100', '200', '300', '400', '500'])
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

  afterEach(() => vi.useRealTimers())

  test('optional reply cooldown cannot suppress the parent walk', async () => {
    resetFxPool()
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname
      paths.push(pathname)
      if (pathname.includes('/conversation/')) {
        return new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
      }
      const tweet = pathname.includes('/thread/')
        ? makeTweet('200', { replying_to: { status: '100' } })
        : makeTweet('100')
      return new Response(JSON.stringify(fxStatusResponse(tweet)))
    }))
    try {
      const result = await fetchPosts('alice', '200', 'full')
      expect(result.tweets.map(tweet => tweet.id)).toEqual(['100', '200'])
      expect(paths).toEqual(['/2/thread/200', '/2/status/100', '/2/conversation/200'])
      await expect(fetchFxStatus('300')).rejects.toMatchObject({ code: 'upstream_rate_limited' })
      expect(paths).toHaveLength(3)
    } finally {
      resetFxPool()
      vi.unstubAllGlobals()
    }
  })

  test('reuses a status payload when the thread endpoint returns no thread', async () => {
    const tweet = makeTweet('100', { article: { title: 'Full article', content: { blocks: [{ text: 'Body' }] } } })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 200, thread: null, status: tweet })))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchFxFullThread('100')

    expect(result).toMatchObject([tweet])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('does not reuse a thread status payload for a different post', async () => {
    const tweet = makeTweet('100')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, thread: null, status: makeTweet('other') })))
      .mockResolvedValueOnce(new Response(JSON.stringify(fxStatusResponse(tweet))))
    vi.stubGlobal('fetch', fetchMock)

    expect(await fetchFxFullThread('100')).toMatchObject([tweet])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('walks only missing ancestors without fetching the focal post again', async () => {
    vi.useFakeTimers()
    const root = makeTweet('100')
    const leaf = makeTweet('200', { replying_to: { status: '100' } })
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const payload = path.includes('/thread/')
        ? { code: 200, thread: null, status: leaf }
        : fxStatusResponse(path.endsWith('/100') ? root : leaf)
      return new Response(JSON.stringify(payload))
    }))

    const started = Date.now()
    const result = fetchFxFullThread('200')
    await vi.runAllTimersAsync()

    expect((await result).map((tweet) => tweet.id)).toEqual(['100', '200'])
    expect(paths).toEqual(['/2/thread/200', '/2/status/100'])
    expect(Date.now() - started).toBe(2000)
  })

  test('keeps the focal payload when an ancestor is unavailable', async () => {
    const leaf = makeTweet('200', { replying_to: { status: '100' }, text: 'complete focal text' })
    const paths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      return new Response(JSON.stringify(path.includes('/thread/')
        ? { code: 200, thread: [leaf] }
        : { code: 404, message: 'NOT_FOUND' }))
    }))

    expect(await fetchFxFullThread('200')).toMatchObject([leaf])
    expect(paths).toEqual(['/2/thread/200', '/2/status/100'])
  })

  test('a private ancestor still rejects the full thread', async () => {
    const leaf = makeTweet('200', { replying_to: { status: '100' } })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => new Response(JSON.stringify(
      String(input).includes('/thread/')
        ? { code: 200, thread: [leaf] }
        : { code: 404, message: 'PRIVATE_TWEET' },
    ))))

    await expect(fetchFxFullThread('200')).rejects.toMatchObject({ status: 404, code: 'private_tweet' })
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

  test('reuses the status included with an empty thread payload', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      code: 200, thread: null, status: makeTweet('200', { quote: makeTweet('100') }),
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchFxThread('200')

    expect(result[0].quote?.id).toBe('100')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('walks parents without fetching the focal post a second time', async () => {
    const root = makeTweet('100')
    const leaf = makeTweet('200', { replying_to: { status: '100' },
      media: { videos: [{ duration: 3, url: 'https://video/clip.mp4' }] } })
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/thread/') ? fxThreadResponse([leaf]) : fxStatusResponse(root),
    ), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchFxFullThread('200')

    expect(result.map(post => post.id)).toEqual(['100', '200'])
    expect(result[1].media?.videos?.[0]?.duration_ms).toBe(3000)
    expect(fetchMock.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
      '/2/thread/200', '/2/status/100',
    ])
  })

  test('does not truncate before the converter can preserve the focal post', async () => {
    const tweets = [makeTweet('1'), makeTweet('2'), makeTweet('3'), makeTweet('4'), makeTweet('5')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxThreadResponse(tweets)), { status: 200 }),
      ),
    )

    const result = await fetchFxFullThread('5')
    expect(result.map((t) => t.id)).toEqual(['1', '2', '3', '4', '5'])
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

  test('uses the focal status supplied with an empty thread instead of fetching it again', async () => {
    const root = makeTweet('100')
    const leaf = makeTweet('200', { replying_to: { status: '100' } })
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/thread/') ? { code: 200, status: leaf, thread: null } : fxStatusResponse(root),
    )))
    vi.stubGlobal('fetch', fetchMock)
    const result = await fetchFxFullThread('200')
    expect(result.map(({ id }) => id)).toEqual(['100', '200'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain('/status/100')
  })

  test('keeps a known focal post when its parent is unavailable', async () => {
    const leaf = makeTweet('200', { replying_to: { status: '100' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/thread/') ? { code: 200, thread: [leaf] } : { code: 404, message: 'NOT_FOUND' },
    ))))
    expect((await fetchFxFullThread('200')).map(({ id }) => id)).toEqual(['200'])
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
  })

  test('keeps explicit private parent failures terminal even with a known focal post', async () => {
    const leaf = makeTweet('200', { replying_to: { status: '100' } })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/thread/') ? { code: 200, thread: [leaf] } : { code: 404, message: 'PRIVATE_TWEET' },
    ))))
    await expect(fetchFxFullThread('200')).rejects.toMatchObject({ code: 'private_tweet' })
  })

  test('another request throttling the provider cannot silently remove required parent context', async () => {
    const { resetFxPool } = await import('./fxtwitter.js')
    const { fetchPosts } = await import('./tweet-fetch.js')
    resetFxPool()
    let releaseThread!: () => void
    const gate = new Promise<void>(resolve => { releaseThread = resolve })
    const leaf = makeTweet('200', { replying_to: { status: '100' } })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/conversation/')) {
        return new Response('{}', { status: 429, headers: { 'Retry-After': '5' } })
      }
      if (url.includes('/thread/')) {
        await gate
        return new Response(JSON.stringify(fxThreadResponse([leaf])))
      }
      return new Response(JSON.stringify(fxStatusResponse(makeTweet('100'))))
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const pending = fetchPosts('ada', '200', 'full')
      const result = expect(pending).rejects.toMatchObject({ code: 'upstream_rate_limited', retryAfter: 5 })
      // Another request can still establish a shared cooldown while this
      // thread is in flight; preserve main's explicit retryable failure.
      await expect(fetchFxConversationReplies('300')).rejects.toMatchObject({ code: 'upstream_rate_limited' })
      releaseThread()
      await result
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      releaseThread()
      resetFxPool()
    }
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
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).not.toContain('https://api.fxtwitter.com/2/status/200')
  })

  test('returns exactly limit posts when thread count equals limit', async () => {
    const tweets = [makeTweet('1'), makeTweet('2'), makeTweet('3')]
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(fxThreadResponse(tweets)), { status: 200 }),
      ),
    )

    const result = await fetchFxFullThread('3')
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

    const result = await fetchFxFullThread('B')
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

describe('fetchFxConversationReplies', () => {
  test('passes cancellation through to the upstream request', async () => {
    const controller = new AbortController()
    let upstreamSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL, init?: RequestInit) => {
      upstreamSignal = init?.signal ?? undefined
      return await new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener('abort', () => reject(upstreamSignal?.reason), { once: true })
      })
    }))

    const pending = fetchFxConversationReplies('20', 'likes', 10, controller.signal)
    const rejected = expect(pending).rejects.toBeInstanceOf(DOMException)
    controller.abort()

    await rejected
    expect(upstreamSignal?.aborted).toBe(true)
  })

  test('keeps only direct replies, sorts by recency, caps, and sends ranking_mode', async () => {
    const replies = Array.from({ length: 12 }, (_, index) => makeTweet(String(index + 1), {
      likes: index,
      created_timestamp: index,
      replying_to: index === 0
        ? { status: 'other' }
        : index === 1
          ? undefined
          : { status: '20' },
    }))
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, replies }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchFxConversationReplies('20', 'recency', 10)

    expect(result.map((tweet) => tweet.id)).toEqual(['12', '11', '10', '9', '8', '7', '6', '5', '4', '3'])
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/2/conversation/20?ranking_mode=recency')
  })

  test('normalizes real FxTwitter formats, seconds, and nested quotes recursively', async () => {
    const tweet = makeTweet('20', { media: { videos: [{
      type: 'video', duration: 4.5, formats: [
        { url: 'https://video/high.mp4', container: 'video/mp4', codec: 'avc1', bitrate: 832000 },
      ],
    }] }, quote: { id: '30', quote: { id: '40', media: { videos: [{ type: 'video', duration: 2 }] } } } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fxStatusResponse(tweet)), { status: 200 }),
    ))
    const result = await fetchFxConversationChain('20')
    expect(result[0].media?.videos?.[0]).toMatchObject({
      duration_ms: 4500,
      variants: [{ url: 'https://video/high.mp4', content_type: 'video/mp4', bitrate: 832000 }],
    })
    expect(result[0].quote?.quote?.media?.videos?.[0]?.duration_ms).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// searchFxStatuses — upstream outage mapping
// ---------------------------------------------------------------------------

describe('searchFxStatuses', () => {
  beforeEach(() => vi.unstubAllGlobals())

  test('maps FxTwitter code 404 (no timeline) to a retryable 503, not not_found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 404, results: [], cursor: { top: null, bottom: null } }), { status: 404 }),
    ))
    await expect(searchFxStatuses('supabase', 'latest')).rejects.toMatchObject({
      status: 503,
      code: 'search_unavailable',
    })
  })

  test('returns empty results on code 200 with no matches', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 200, results: [], cursor: { top: null, bottom: null } }), { status: 200 }),
    ))
    await expect(searchFxStatuses('xyzzyqwv9182nothing', 'latest')).resolves.toEqual({
      results: [],
      cursor: { top: null, bottom: null },
    })
  })
})

describe('retryAfterSeconds', () => {
  test('reads delay-seconds and HTTP-dates', async () => {
    const { retryAfterSeconds } = await import('./fxtwitter.js')
    expect(retryAfterSeconds('7')).toBe(7)
    expect(retryAfterSeconds('0')).toBeUndefined()
    expect(retryAfterSeconds(null)).toBeUndefined()
    expect(retryAfterSeconds('soon')).toBeUndefined()
    const seconds = retryAfterSeconds(new Date(Date.now() + 90_000).toUTCString())
    expect(seconds).toBeGreaterThanOrEqual(89)
    expect(seconds).toBeLessThanOrEqual(91)
    expect(retryAfterSeconds(new Date(Date.now() - 90_000).toUTCString())).toBe(1)
  })
})

test('overlapping throttled requests preserve the longest provider cooldown', async () => {
  resetFxPool()
  vi.useFakeTimers({ toFake: ['Date'] })
  const responses: Array<(response: Response) => void> = []
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)))
  vi.stubGlobal('fetch', fetchMock)
  try {
    const status = expect(fetchFxStatus('20')).rejects.toMatchObject({ code: 'upstream_rate_limited', retryAfter: 30 })
    const replies = expect(fetchFxConversationReplies('20')).rejects.toMatchObject({ code: 'upstream_rate_limited', retryAfter: 25 })
    responses[0](new Response('', { status: 429, headers: { 'retry-after': '30' } }))
    await status
    vi.setSystemTime(Date.now() + 5000)
    responses[1](new Response('', { status: 429, headers: { 'retry-after': '5' } }))
    await replies

    await expect(fetchFxStatus('21')).rejects.toMatchObject({ code: 'upstream_rate_limited', retryAfter: 25 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
    resetFxPool()
  }
})

test('rejects malformed timeline payloads instead of treating them as an empty floor', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 200 }), { status: 200 })))
  await expect(fetchFxProfileStatuses('ada', 'cursor')).rejects.toMatchObject({ code: 'partial_upstream_failure' })
})

test('recovers one transient identity miss without failing the circle', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 404, message: 'NOT_FOUND' })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ user: { screen_name: 'ada' } })))
  vi.stubGlobal('fetch', fetch)
  expect(await fetchFxProfile('ada')).toMatchObject({ screen_name: 'ada' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('maps a search transport failure into the live-fallback error contract', async () => {
  const { resetFxPool } = await import('./fxtwitter.js')
  resetFxPool()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network unavailable') }))
  await expect(searchFxStatuses('@ada','latest')).rejects.toMatchObject({code:'search_unavailable',status:503})
})
