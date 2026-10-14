import { trackFallback } from './server-events.js'
import { ConvertError } from './errors.js'
import { fetchContextDevStatus } from './contextdev.js'
import { fetchFirecrawlStatus } from './firecrawl.js'
import {
  fetchFxConversationReplies,
  fetchFxFullThread,
  fetchFxStatus,
  type FxTweet,
} from './fxtwitter.js'
import { fetchSyndicationStatus } from './syndication.js'

export type FetchSource = 'fxtwitter' | 'syndication' | 'contextdev' | 'firecrawl'

export interface FetchResult {
  tweets: FxTweet[]
  source: FetchSource
}

export type ContextMode = 'full' | 'thread'
export type RepliesMode = 'top' | 'recent' | 'off'

function annotateAndDedupe(thread: FxTweet[], requestedId: string, replies: FxTweet[]): FxTweet[] {
  const requestedIndex = thread.findIndex((tweet) => tweet.id === requestedId)
  const seen = new Set<string>()
  const output: FxTweet[] = []
  const add = (tweet: FxTweet, context: FxTweet['context']) => {
    if (tweet.id && seen.has(tweet.id)) return
    if (tweet.id) seen.add(tweet.id)
    output.push({ ...tweet, context })
  }

  thread.forEach((tweet, index) => {
    const context = tweet.id === requestedId
      ? 'post'
      : requestedIndex >= 0 && index < requestedIndex ? 'parent' : 'thread'
    add(tweet, context)
  })
  replies.forEach((tweet) => add(tweet, 'reply'))
  return output
}

function focalAuthorThread(thread: FxTweet[], requestedId: string, requestedHandle: string): FxTweet[] {
  const focal = thread.find((tweet) => tweet.id === requestedId)
  const authorId = focal?.author?.id
  const handle = focal?.author?.screen_name?.toLowerCase() ?? requestedHandle.toLowerCase()
  return thread.filter((tweet) => {
    if (tweet.id === requestedId) return true
    if (authorId) return tweet.author?.id === authorId
    return Boolean(handle && tweet.author?.screen_name?.toLowerCase() === handle)
  })
}

function isHardNotFound(error: unknown): boolean {
  return error instanceof ConvertError && error.code === 'private_tweet'
}

async function fetchStatusWithFallback(handle: string, id: string): Promise<FetchResult> {
  const controller = new AbortController()
  let syndication: Promise<FxTweet> | undefined
  const startSyndication = () => {
    syndication ??= fetchSyndicationStatus(handle, id, controller.signal)
    // The hedge can fail before the primary settles. Keep that rejection
    // handled, while retaining it for the usual ordered fallback below.
    void syndication.catch(() => {})
    return syndication
  }
  // Prepare the free fallback on a slow primary, but never accept it before
  // the primary fails: it can contain less data or hide a private-post error.
  const hedge = setTimeout(startSyndication, 250)
  const attempts: Array<() => Promise<FetchResult>> = [
    async () => ({ tweets: [await fetchFxStatus(id)], source: 'fxtwitter' }),
    async () => ({ tweets: [await startSyndication()], source: 'syndication' }),
  ]

  if (process.env.CONTEXT_DEV_API_KEY) {
    attempts.push(async () => ({
      tweets: [await fetchContextDevStatus(handle, id)],
      source: 'contextdev',
    }))
  }

  if (process.env.FIRECRAWL_API_KEY) {
    attempts.push(async () => ({
      tweets: [await fetchFirecrawlStatus(handle, id)],
      source: 'firecrawl',
    }))
  }

  let lastError: unknown

  const sources: FetchSource[] = ['fxtwitter', 'syndication', ...(process.env.CONTEXT_DEV_API_KEY ? ['contextdev' as const] : []), ...(process.env.FIRECRAWL_API_KEY ? ['firecrawl' as const] : [])]
  try {
    for (const [index, attempt] of attempts.entries()) {
      try {
        const result = await attempt()
        // Only a fallback that actually served the request counts as used.
        if (index > 0) trackFallback(sources[index - 1], sources[index], lastError instanceof ConvertError && lastError.code?.endsWith('_empty') ? 'primary_empty' : 'primary_error')
        return result
      } catch (error) {
        lastError = error
        if (isHardNotFound(error)) throw error
      }
    }
  } finally {
    clearTimeout(hedge)
    controller.abort()
  }

  throw lastError instanceof ConvertError
    ? lastError
    : new ConvertError(502, 'All fetch providers failed.', 'all_providers_failed')
}

export async function fetchPosts(
  handle: string,
  id: string,
  threadMode: 'off' | 'full',
  contextMode: ContextMode = 'full',
  repliesMode: RepliesMode = 'top',
): Promise<FetchResult> {
  if (threadMode === 'off') {
    const result = await fetchStatusWithFallback(handle, id)
    return { ...result, tweets: annotateAndDedupe(result.tweets, id, []) }
  }

  const threadPromise = fetchFxFullThread(id)
  const repliesController = new AbortController()
  // Thread assembly and ranked replies do not depend on each other. Handle
  // reply failures immediately so a failed thread cannot leave an unhandled
  // rejection; replies remain additive and never supply the focal post.
  const repliesPromise = repliesMode !== 'off' && contextMode !== 'thread'
    ? fetchFxConversationReplies(id, repliesMode === 'recent' ? 'recency' : 'likes', 10, repliesController.signal).catch(() => [])
    : Promise.resolve<FxTweet[]>([])

  try {
    const assembledThread = await threadPromise
    const thread = contextMode === 'thread'
      ? focalAuthorThread(assembledThread, id, handle)
      : assembledThread
    if (repliesMode === 'off' || contextMode === 'thread') {
      return { tweets: annotateAndDedupe(thread, id, []), source: 'fxtwitter' }
    }

    const replies = (await repliesPromise) ?? []
    return { tweets: annotateAndDedupe(thread, id, replies), source: 'fxtwitter' }
  } catch (error) {
    if (isHardNotFound(error) || (error instanceof ConvertError && error.code === 'upstream_rate_limited')) throw error
  } finally {
    // A failed/private thread must not keep an unused reply fetch running.
    repliesController.abort()
  }

  const result = await fetchStatusWithFallback(handle, id)
  return { ...result, tweets: annotateAndDedupe(result.tweets, id, []) }
}
