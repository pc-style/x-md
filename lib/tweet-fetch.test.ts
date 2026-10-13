import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ConvertError } from './errors.js'

vi.mock('./fxtwitter.js', () => ({
  fetchFxConversationReplies: vi.fn(),
  fetchFxFullThread: vi.fn(),
  fetchFxStatus: vi.fn(),
}))

vi.mock('./syndication.js', () => ({
  fetchSyndicationStatus: vi.fn(),
}))

vi.mock('./contextdev.js', () => ({
  fetchContextDevStatus: vi.fn(),
}))

vi.mock('./firecrawl.js', () => ({
  fetchFirecrawlStatus: vi.fn(),
}))

import { fetchPosts } from './tweet-fetch.js'
import { fetchFxConversationReplies, fetchFxFullThread, fetchFxStatus } from './fxtwitter.js'
import { fetchSyndicationStatus } from './syndication.js'
import { fetchContextDevStatus } from './contextdev.js'
import { fetchFirecrawlStatus } from './firecrawl.js'

const ORIGINAL_CONTEXT_KEY = process.env.CONTEXT_DEV_API_KEY
const ORIGINAL_FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY

function restoreEnv() {
  if (ORIGINAL_CONTEXT_KEY === undefined) delete process.env.CONTEXT_DEV_API_KEY
  else process.env.CONTEXT_DEV_API_KEY = ORIGINAL_CONTEXT_KEY
  if (ORIGINAL_FIRECRAWL_KEY === undefined) delete process.env.FIRECRAWL_API_KEY
  else process.env.FIRECRAWL_API_KEY = ORIGINAL_FIRECRAWL_KEY
}

describe('fetchPosts provider fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(fetchFxConversationReplies).mockResolvedValue([])
    delete process.env.CONTEXT_DEV_API_KEY
    delete process.env.FIRECRAWL_API_KEY
  })

  afterEach(() => { restoreEnv(); vi.useRealTimers() })

  test('uses Context.dev after FxTwitter and syndication when configured', async () => {
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
    vi.mocked(fetchFxStatus).mockRejectedValue(new ConvertError(502, 'fx down', 'fxtwitter_error'))
    vi.mocked(fetchSyndicationStatus).mockRejectedValue(
      new ConvertError(502, 'syndication down', 'syndication_error'),
    )
    vi.mocked(fetchContextDevStatus).mockResolvedValue({ id: '123', text: 'from contextdev' })

    const result = await fetchPosts('alice', '123', 'off')

    expect(result).toEqual({
      tweets: [{ id: '123', text: 'from contextdev', context: 'post' }],
      source: 'contextdev',
    })
    expect(fetchContextDevStatus).toHaveBeenCalledWith('alice', '123')
    expect(fetchFirecrawlStatus).not.toHaveBeenCalled()
  })

  test('falls through from Context.dev to Firecrawl when both are configured', async () => {
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
    process.env.FIRECRAWL_API_KEY = 'fc_test'
    vi.mocked(fetchFxStatus).mockRejectedValue(new ConvertError(502, 'fx down', 'fxtwitter_error'))
    vi.mocked(fetchSyndicationStatus).mockRejectedValue(
      new ConvertError(502, 'syndication down', 'syndication_error'),
    )
    vi.mocked(fetchContextDevStatus).mockRejectedValue(
      new ConvertError(502, 'context down', 'contextdev_error'),
    )
    vi.mocked(fetchFirecrawlStatus).mockResolvedValue({ id: '123', text: 'from firecrawl' })

    const result = await fetchPosts('alice', '123', 'off')

    expect(result).toEqual({
      tweets: [{ id: '123', text: 'from firecrawl', context: 'post' }],
      source: 'firecrawl',
    })
    expect(fetchContextDevStatus).toHaveBeenCalledWith('alice', '123')
    expect(fetchFirecrawlStatus).toHaveBeenCalledWith('alice', '123')
  })

  test('does not try optional scrape providers when keys are absent', async () => {
    vi.mocked(fetchFxStatus).mockRejectedValue(new ConvertError(502, 'fx down', 'fxtwitter_error'))
    vi.mocked(fetchSyndicationStatus).mockResolvedValue({ id: '123', text: 'from syndication' })

    const result = await fetchPosts('alice', '123', 'off')

    expect(result.source).toBe('syndication')
    expect(fetchContextDevStatus).not.toHaveBeenCalled()
    expect(fetchFirecrawlStatus).not.toHaveBeenCalled()
  })

  test('hedges slow status fetches without letting a faster fallback replace the primary', async () => {
    vi.useFakeTimers()
    let finishStatus!: (tweet: { id: string; text: string }) => void
    vi.mocked(fetchFxStatus).mockReturnValueOnce(new Promise(resolve => { finishStatus = resolve }))
    vi.mocked(fetchSyndicationStatus).mockResolvedValueOnce({ id: '2', text: 'less complete fallback' })
    const pending = fetchPosts('alice', '2', 'off')

    await vi.advanceTimersByTimeAsync(300)
    const hedged = vi.mocked(fetchSyndicationStatus).mock.calls.length
    finishStatus({ id: '2', text: 'complete primary' })
    const result = await pending

    expect(hedged).toBe(1)
    expect(result).toEqual({ source: 'fxtwitter', tweets: [{ id: '2', text: 'complete primary', context: 'post' }] })
  })

  test('a hedged fallback cannot override a delayed private-post error', async () => {
    vi.useFakeTimers()
    let failStatus!: (error: unknown) => void
    vi.mocked(fetchFxStatus).mockReturnValueOnce(new Promise((_resolve, reject) => { failStatus = reject }))
    vi.mocked(fetchSyndicationStatus).mockResolvedValueOnce({ id: '2', text: 'fallback' })
    const pending = fetchPosts('alice', '2', 'off')
    const check = expect(pending).rejects.toMatchObject({ code: 'private_tweet' })

    await vi.advanceTimersByTimeAsync(300)
    failStatus(new ConvertError(404, 'private', 'private_tweet'))

    await check
    expect(fetchContextDevStatus).not.toHaveBeenCalled()
    expect(fetchFirecrawlStatus).not.toHaveBeenCalled()
  })

  test('cancels the hedge timer when the primary is fast', async () => {
    vi.useFakeTimers()
    vi.mocked(fetchFxStatus).mockResolvedValueOnce({ id: '2', text: 'primary' })
    await fetchPosts('alice', '2', 'off')
    await vi.advanceTimersByTimeAsync(300)
    expect(fetchSyndicationStatus).not.toHaveBeenCalled()
  })

  test('uses an already completed hedge only after the primary fails', async () => {
    vi.useFakeTimers()
    let failStatus!: (error: unknown) => void
    vi.mocked(fetchFxStatus).mockReturnValueOnce(new Promise((_resolve, reject) => { failStatus = reject }))
    vi.mocked(fetchSyndicationStatus).mockResolvedValueOnce({ id: '2', text: 'fallback' })
    let settled = false
    const pending = fetchPosts('alice', '2', 'off').then(result => { settled = true; return result })

    await vi.advanceTimersByTimeAsync(1000)
    expect(settled).toBe(false)
    failStatus(new ConvertError(502, 'fx down', 'fxtwitter_network'))
    const result = await pending

    expect(result.source).toBe('syndication')
    expect(fetchSyndicationStatus).toHaveBeenCalledOnce()
    expect(fetchSyndicationStatus.mock.calls[0][2]?.aborted).toBe(true)
  })

  test('failed speculative replies are cancelled before the fallback result is served', async () => {
    vi.mocked(fetchFxFullThread).mockRejectedValueOnce(new ConvertError(502, 'thread down', 'fxtwitter_network'))
    vi.mocked(fetchFxConversationReplies).mockReturnValueOnce(new Promise(() => {}))
    vi.mocked(fetchFxStatus).mockResolvedValueOnce({ id: '2', text: 'fallback status' })

    const result = await fetchPosts('alice', '2', 'full')

    expect(result.tweets).toEqual([{ id: '2', text: 'fallback status', context: 'post' }])
    expect(vi.mocked(fetchFxConversationReplies).mock.calls[0][3]?.aborted).toBe(true)
  })

  test('thread=full still starts with FxTwitter full thread before fallback chain', async () => {
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
    vi.mocked(fetchFxFullThread).mockResolvedValue([{ id: '1', text: 'thread' }])

    const result = await fetchPosts('alice', '123', 'full')

    expect(result).toEqual({ tweets: [{ id: '1', text: 'thread', context: 'thread' }], source: 'fxtwitter' })
    expect(fetchFxFullThread).toHaveBeenCalledWith('123')
    expect(fetchFxStatus).not.toHaveBeenCalled()
    expect(fetchContextDevStatus).not.toHaveBeenCalled()
  })

  test('appends top replies in API order, caps, dedupes, and labels context', async () => {
    vi.mocked(fetchFxFullThread).mockResolvedValue([
      { id: '1', text: 'parent' }, { id: '2', text: 'post' }, { id: '3', text: 'continuation' },
    ])
    vi.mocked(fetchFxConversationReplies).mockResolvedValue([
      { id: '3', text: 'duplicate' }, { id: '4', text: 'reply' },
    ])

    const result = await fetchPosts('alice', '2', 'full')

    expect(fetchFxConversationReplies).toHaveBeenCalledWith('2', 'likes', 10, expect.any(AbortSignal))
    expect(result.tweets.map(({ id, context }) => ({ id, context }))).toEqual([
      { id: '1', context: 'parent' }, { id: '2', context: 'post' },
      { id: '3', context: 'thread' }, { id: '4', context: 'reply' },
    ])
  })

  test('starts replies before the independent thread fetch finishes', async () => {
    let finishThread!: (tweets: Array<{ id: string; text: string }>) => void
    vi.mocked(fetchFxFullThread).mockReturnValueOnce(new Promise(resolve => { finishThread = resolve }))
    vi.mocked(fetchFxConversationReplies).mockResolvedValue([{ id: '3', text: 'reply' }])

    const pending = fetchPosts('alice', '2', 'full')
    const repliesStarted = vi.mocked(fetchFxConversationReplies).mock.calls.length
    finishThread([{ id: '2', text: 'post' }])
    const result = await pending

    expect(repliesStarted).toBe(1)
    expect(result.tweets.map(post => post.id)).toEqual(['2', '3'])
  })

  test('private thread errors win over successful speculative replies', async () => {
    vi.mocked(fetchFxFullThread).mockRejectedValueOnce(new ConvertError(404, 'private', 'private_tweet'))
    vi.mocked(fetchFxConversationReplies).mockResolvedValue([{ id: '3', text: 'reply' }])

    await expect(fetchPosts('alice', '2', 'full')).rejects.toMatchObject({ code: 'private_tweet' })
    expect(fetchFxStatus).not.toHaveBeenCalled()
    expect(fetchSyndicationStatus).not.toHaveBeenCalled()
  })

  test('recent maps to recency and conversation failure keeps the thread', async () => {
    vi.mocked(fetchFxFullThread).mockResolvedValue([{ id: '2', text: 'post' }])
    vi.mocked(fetchFxConversationReplies).mockRejectedValue(new Error('conversation unavailable'))
    const result = await fetchPosts('alice', '2', 'full', 'full', 'recent')
    expect(fetchFxConversationReplies).toHaveBeenCalledWith('2', 'recency', 10, expect.any(AbortSignal))
    expect(result.tweets).toEqual([{ id: '2', text: 'post', context: 'post' }])
  })

  test('thread context and replies=off both opt out of conversation requests', async () => {
    vi.mocked(fetchFxFullThread).mockResolvedValue([{ id: '2' }])
    await fetchPosts('alice', '2', 'full', 'thread', 'top')
    await fetchPosts('alice', '2', 'full', 'full', 'off')
    expect(fetchFxConversationReplies).not.toHaveBeenCalled()
  })

  test('thread context retains only the focal author while replies=off preserves full parents', async () => {
    vi.mocked(fetchFxFullThread).mockResolvedValue([
      { id: '1', author: { screen_name: 'other' } },
      { id: '2', author: { screen_name: 'Alice' } },
      { id: '3', author: { screen_name: 'alice' } },
    ])
    const authorThread = await fetchPosts('alice', '2', 'full', 'thread', 'top')
    expect(authorThread.tweets.map((tweet) => tweet.id)).toEqual(['2', '3'])
    const noReplies = await fetchPosts('alice', '2', 'full', 'full', 'off')
    expect(noReplies.tweets.map((tweet) => tweet.id)).toEqual(['1', '2', '3'])
  })

  test('uses the requested handle when focal author metadata is missing', async () => {
    vi.mocked(fetchFxFullThread).mockResolvedValue([
      { id: '1', author: { screen_name: 'other' } },
      { id: '2' },
      { id: '3', author: { screen_name: 'Alice' } },
    ])

    const result = await fetchPosts('alice', '2', 'full', 'thread', 'top')
    expect(result.tweets.map((tweet) => tweet.id)).toEqual(['2', '3'])
  })
})
