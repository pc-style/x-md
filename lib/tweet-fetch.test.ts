import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ConvertError } from './errors.js'

vi.mock('./fxtwitter.js', () => ({
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
import { fetchFxFullThread, fetchFxStatus } from './fxtwitter.js'
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
    delete process.env.CONTEXT_DEV_API_KEY
    delete process.env.FIRECRAWL_API_KEY
  })

  afterEach(restoreEnv)

  test('uses Context.dev after FxTwitter and syndication when configured', async () => {
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
    vi.mocked(fetchFxStatus).mockRejectedValue(new ConvertError(502, 'fx down', 'fxtwitter_error'))
    vi.mocked(fetchSyndicationStatus).mockRejectedValue(
      new ConvertError(502, 'syndication down', 'syndication_error'),
    )
    vi.mocked(fetchContextDevStatus).mockResolvedValue({ id: '123', text: 'from contextdev' })

    const result = await fetchPosts('alice', '123', 'off')

    expect(result).toEqual({
      tweets: [{ id: '123', text: 'from contextdev' }],
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
      tweets: [{ id: '123', text: 'from firecrawl' }],
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

  test('thread=full still starts with FxTwitter full thread before fallback chain', async () => {
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
    vi.mocked(fetchFxFullThread).mockResolvedValue([{ id: '1', text: 'thread' }])

    const result = await fetchPosts('alice', '123', 'full')

    expect(result).toEqual({ tweets: [{ id: '1', text: 'thread' }], source: 'fxtwitter' })
    expect(fetchFxFullThread).toHaveBeenCalledWith('123')
    expect(fetchFxStatus).not.toHaveBeenCalled()
    expect(fetchContextDevStatus).not.toHaveBeenCalled()
  })
})
