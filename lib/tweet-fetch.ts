import { ConvertError } from './errors.js'
import { fetchFirecrawlStatus } from './firecrawl.js'
import { fetchFxFullThread, fetchFxStatus, type FxTweet } from './fxtwitter.js'
import { fetchSyndicationStatus } from './syndication.js'

export type FetchSource = 'fxtwitter' | 'syndication' | 'firecrawl'

export interface FetchResult {
  tweets: FxTweet[]
  source: FetchSource
}

function isHardNotFound(error: unknown): boolean {
  return error instanceof ConvertError && error.code === 'private_tweet'
}

async function fetchStatusWithFallback(handle: string, id: string): Promise<FetchResult> {
  const attempts: Array<() => Promise<FetchResult>> = [
    async () => ({ tweets: [await fetchFxStatus(id)], source: 'fxtwitter' }),
    async () => ({ tweets: [await fetchSyndicationStatus(handle, id)], source: 'syndication' }),
  ]

  if (process.env.FIRECRAWL_API_KEY) {
    attempts.push(async () => ({
      tweets: [await fetchFirecrawlStatus(handle, id)],
      source: 'firecrawl',
    }))
  }

  let lastError: unknown

  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      if (isHardNotFound(error)) throw error
    }
  }

  throw lastError instanceof ConvertError
    ? lastError
    : new ConvertError(502, 'All fetch providers failed.', 'all_providers_failed')
}

export async function fetchPosts(
  handle: string,
  id: string,
  threadMode: 'off' | 'full',
): Promise<FetchResult> {
  if (threadMode === 'off') {
    return fetchStatusWithFallback(handle, id)
  }

  try {
    const tweets = await fetchFxFullThread(id)
    return { tweets, source: 'fxtwitter' }
  } catch (error) {
    if (isHardNotFound(error)) throw error
  }

  return fetchStatusWithFallback(handle, id)
}
