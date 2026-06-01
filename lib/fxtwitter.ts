import { ConvertError } from './errors.js'

const FX_BASE = 'https://api.fxtwitter.com'
const UA = 'x-md/1.0'

export interface FxAuthor {
  name?: string
  screen_name?: string
  url?: string
  description?: string
  location?: string
  followers?: number
  following?: number
  likes?: number
  media_count?: number
  statuses?: number
  joined?: string
  avatar_url?: string
  banner_url?: string
  website?: { url?: string; display_url?: string }
  verification?: { verified?: boolean; type?: string }
}

export interface FxMediaItem {
  type?: string
  url?: string
  thumbnail_url?: string
  width?: number
  height?: number
  duration?: number
  format?: string
}

export interface FxMedia {
  photos?: FxMediaItem[]
  videos?: FxMediaItem[]
  animated?: FxMediaItem[]
  mosaic?: { photos?: FxMediaItem[] }
  all?: FxMediaItem[]
}

export interface FxArticleBlock {
  type?: string
  text?: string
  inlineStyleRanges?: Array<{ offset: number; length: number; style: string }>
  data?: { urls?: Array<{ fromIndex: number; toIndex: number; text: string }> }
}

export interface FxArticle {
  title?: string
  preview_text?: string
  content?: { blocks?: FxArticleBlock[] }
  cover_media?: {
    media_info?: { original_img_url?: string }
  }
}

export interface FxReplyingTo {
  screen_name?: string
  status?: string
  url?: string
}

export interface FxTweet {
  url?: string
  id?: string
  text?: string
  created_at?: string
  created_timestamp?: number
  author?: FxAuthor
  replies?: number
  retweets?: number
  reposts?: number
  likes?: number
  views?: number | null
  bookmarks?: number
  quotes?: number
  lang?: string
  source?: string
  replying_to?: string[] | FxReplyingTo | null
  replying_to_status?: string[] | null
  possibly_sensitive?: boolean
  media?: FxMedia
  quote?: FxTweet
  article?: FxArticle
  poll?: unknown
  community_note?: unknown
}

interface FxApiResponse {
  code?: number
  message?: string
  tweet?: FxTweet
  status?: FxTweet
  thread?: FxTweet[]
}

function normalizeTweet(raw: FxTweet): FxTweet {
  return {
    ...raw,
    retweets: raw.retweets ?? raw.reposts,
    media: raw.media && Object.keys(raw.media).length > 0 ? raw.media : undefined,
  }
}

function pickTweet(data: FxApiResponse): FxTweet | undefined {
  const raw = data.status ?? data.tweet
  return raw ? normalizeTweet(raw) : undefined
}

async function fxFetch(path: string): Promise<FxApiResponse> {
  let response: Response
  try {
    response = await fetch(`${FX_BASE}/${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
    })
  } catch {
    throw new ConvertError(502, 'Failed to reach FxTwitter API.', 'fxtwitter_network')
  }

  const data = (await response.json()) as FxApiResponse

  if (data.code === 404 || data.message === 'NOT_FOUND') {
    throw new ConvertError(404, 'Post not found or unavailable.', 'not_found')
  }

  if (data.message === 'PRIVATE_TWEET') {
    throw new ConvertError(404, 'Post is private and cannot be fetched.', 'private_tweet')
  }

  if (!response.ok || (data.code && data.code >= 400)) {
    throw new ConvertError(
      502,
      `FxTwitter API error: ${data.message ?? response.status}.`,
      'fxtwitter_error',
    )
  }

  return data
}

export async function fetchFxStatus(id: string): Promise<FxTweet> {
  const data = await fxFetch(`2/status/${id}`)
  const tweet = pickTweet(data)
  if (!tweet) {
    throw new ConvertError(404, 'Post not found.', 'not_found')
  }
  return tweet
}

export function getParentStatusId(tweet: FxTweet): string | undefined {
  const replyingTo = tweet.replying_to
  if (replyingTo && !Array.isArray(replyingTo) && typeof replyingTo === 'object') {
    const status = replyingTo.status
    if (status != null && status !== '') return String(status)
  }

  const statusIds = tweet.replying_to_status
  if (statusIds?.length) return String(statusIds[0])

  return undefined
}

export async function fetchFxConversationChain(id: string, limit = 100): Promise<FxTweet[]> {
  const chain: FxTweet[] = []
  const visited = new Set<string>()
  let currentId = id

  while (true) {
    if (visited.has(currentId)) break
    visited.add(currentId)

    const tweet = await fetchFxStatus(currentId)
    chain.unshift(tweet)

    const parentId = getParentStatusId(tweet)
    if (!parentId) break
    currentId = parentId
  }

  return chain.slice(0, limit)
}

export async function fetchFxFullThread(id: string, limit = 100): Promise<FxTweet[]> {
  const data = await fxFetch(`2/thread/${id}`)
  const thread = data.thread?.map(normalizeTweet)

  if (thread && thread.length > 1) {
    return thread.slice(0, limit)
  }

  const tweet = thread?.[0] ?? (await fetchFxStatus(id))
  if (!getParentStatusId(tweet)) {
    return [tweet]
  }

  const chain = await fetchFxConversationChain(id, limit)
  return chain.length > 0 ? chain : [tweet]
}

export async function fetchFxThread(id: string): Promise<FxTweet[]> {
  return fetchFxFullThread(id)
}
