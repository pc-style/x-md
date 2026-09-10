import { providerFetch, reportProviderResponse, trackUpstream } from './server-events.js'
import { ConvertError } from './errors.js'

/**
 * Upstream pool. `FXTWITTER_BASE_URL` is one base URL or a comma-separated
 * list (own FxEmbed deployments, the public instance last). Requests rotate
 * across the pool; a base that answers 429 sits out for its `Retry-After`,
 * so a walk keeps going on the others. Each base is capped independently by
 * FX_PER_BASE_INFLIGHT (lib/import.ts reads the pool size for its own cap).
 */
export const FX_BASES: readonly string[] = (process.env.FXTWITTER_BASE_URL ?? 'https://api.fxtwitter.com')
  .split(',').map((base) => base.trim().replace(/\/+$/, '')).filter(Boolean)
const coolUntil = new Map<string, number>()
let rotation = 0

/** The next base that is not cooling down; the least-recently-cooled one when all are. */
export function pickFxBase(): string {
  const now = Date.now()
  for (let i = 0; i < FX_BASES.length; i += 1) {
    const base = FX_BASES[(rotation + i) % FX_BASES.length]
    if ((coolUntil.get(base) ?? 0) <= now) {
      rotation = (rotation + i + 1) % FX_BASES.length
      return base
    }
  }
  return [...FX_BASES].sort((a, b) => (coolUntil.get(a) ?? 0) - (coolUntil.get(b) ?? 0))[0]
}

/** Test hook. */
export function resetFxPool(): void {
  coolUntil.clear()
  rotation = 0
}
const UA = 'x-md/1.0'

export interface FxAuthor {
  id?: string
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
  protected?: boolean
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
  /** Normalized duration. FxTwitter sends seconds; syndication sends milliseconds. */
  duration_ms?: number
  format?: string
  bitrate?: number
  alt?: string
  altText?: string
  variants?: Array<{
    url: string
    content_type?: string
    bitrate?: number
  }>
  formats?: Array<{
    url: string
    container?: string
    codec?: string
    bitrate?: number
  }>
}

export interface FxMosaic {
  type?: string
  photos?: FxMediaItem[]
  formats?: { jpeg?: string; webp?: string }
}

export interface FxMedia {
  photos?: FxMediaItem[]
  videos?: FxMediaItem[]
  animated?: FxMediaItem[]
  mosaic?: FxMosaic
  all?: FxMediaItem[]
}

export interface FxPollChoice {
  label?: string
  count?: number
  percentage?: number
}

export interface FxPoll {
  choices?: FxPollChoice[]
  total_votes?: number
  time_left_en?: string
  ends_at?: string
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

/** FxTwitter may return a single parent object or legacy string[] handles. */
export type FxReplyingTo =
  | string[]
  | {
      screen_name?: string
      status?: string
      url?: string
      profile_url?: string
    }
  | null

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
  replying_to?: FxReplyingTo
  replying_to_status?: string[] | null
  possibly_sensitive?: boolean
  media?: FxMedia
  quote?: FxTweet
  reposted_by?: FxAuthor | null
  article?: FxArticle
  poll?: FxPoll
  community_note?: unknown
  /** How this post relates to the status requested by the caller. */
  context?: 'parent' | 'post' | 'thread' | 'reply'
}

interface FxApiResponse {
  code?: number
  message?: string
  tweet?: FxTweet
  status?: FxTweet
  thread?: FxTweet[]
}

interface FxConversationResponse {
  results?: FxTweet[]
  tweets?: FxTweet[]
  conversation?: FxTweet[]
  replies?: FxTweet[] | null
}

export interface FxCursor {
  top?: string
  bottom?: string
}

export interface FxListResponse<T> {
  results: T[]
  cursor?: FxCursor
  /** Upstream requests it took to get this page (short-page retries, see fetchFxProfileStatuses). */
  attempts?: number
}

function normalizeMediaItem(item: FxMediaItem): FxMediaItem {
  const formatVariants = item.formats?.filter((format) => format.url).map((format) => ({
    url: format.url,
    content_type: format.container?.includes('/')
      ? format.container
      : format.container === 'mp4'
      ? 'video/mp4'
      : format.container === 'webm'
        ? 'video/webm'
        : format.container === 'm3u8'
          ? 'application/vnd.apple.mpegurl'
          : undefined,
    bitrate: format.bitrate,
  }))
  return {
    ...item,
    alt: item.alt ?? item.altText,
    duration_ms: item.duration_ms ?? (item.duration != null ? item.duration * 1000 : undefined),
    variants: item.variants ?? formatVariants,
  }
}

function normalizeMedia(media?: FxMedia): FxMedia | undefined {
  if (!media || Object.keys(media).length === 0) return undefined
  const map = (items?: FxMediaItem[]) => items?.map(normalizeMediaItem)
  return {
    ...media,
    photos: map(media.photos),
    videos: map(media.videos),
    animated: map(media.animated),
    all: map(media.all),
    mosaic: media.mosaic ? { ...media.mosaic, photos: map(media.mosaic.photos) } : undefined,
  }
}

function normalizeTweet(raw: FxTweet): FxTweet {
  return {
    ...raw,
    retweets: raw.retweets ?? raw.reposts,
    media: normalizeMedia(raw.media),
    quote: raw.quote ? normalizeTweet(raw.quote) : undefined,
  }
}

function pickTweet(data: FxApiResponse): FxTweet | undefined {
  const raw = data.status ?? data.tweet
  return raw ? normalizeTweet(raw) : undefined
}

/** `Retry-After` is delay-seconds or an HTTP-date (RFC 9110 §10.2.3); both become whole seconds. */
export function retryAfterSeconds(header: string | null): number | undefined {
  const raw = header?.trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10) || undefined
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  return Math.max(1, Math.ceil((at - Date.now()) / 1000))
}

async function fxFetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let response: Response
  const base = pickFxBase()
  try {
    response = await providerFetch('fxtwitter', `${base}/${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new ConvertError(502, 'Failed to reach FxTwitter API.', 'fxtwitter_network')
  }

  if (response.status === 429) {
    const retryAfter = retryAfterSeconds(response.headers.get('retry-after')) ?? 5
    coolUntil.set(base, Date.now() + retryAfter * 1000)
    // With more than one base the caller can retry at once on another one.
    throw new ConvertError(503, 'FxTwitter is rate limiting x.md right now.', 'upstream_rate_limited', FX_BASES.length > 1 ? 0 : retryAfter)
  }
  // A self-hosted instance whose accounts are exhausted answers 5xx rather than
  // 429; in a pool that base sits out briefly and the page moves to the next one.
  if (response.status >= 500 && FX_BASES.length > 1) {
    coolUntil.set(base, Date.now() + FX_UPSTREAM_ERROR_COOLDOWN_MS)
    throw new ConvertError(503, `FxTwitter upstream ${new URL(base).host} answered ${response.status}.`, 'upstream_rate_limited', 0)
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

  // A valid empty list is not an outage; a missing expected payload is.
  if (path.startsWith('2/status/') && !data.status && !data.tweet) reportProviderResponse(response, 'empty_response')
  else if (/^2\/profile\/[^/?]+$/.test(path) && !(data as { user?: unknown }).user) reportProviderResponse(response, 'empty_response')
  else if ((path.startsWith('2/search?') || /^2\/profile\/[^/]+\/(statuses|followers|following)/.test(path)) && !Array.isArray((data as { results?: unknown }).results)) reportProviderResponse(response, 'parse_failure')

  return data as T
}

async function fxFetch(path: string): Promise<FxApiResponse> {
  return fxFetchJson<FxApiResponse>(path)
}

function encodeQuery(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  return query.toString()
}

export async function fetchFxProfile(handle: string): Promise<FxAuthor> {
  const data = await fxFetchJson<{ user?: FxAuthor }>(`2/profile/${encodeURIComponent(handle)}`)
  if (!data.user) throw new ConvertError(404, 'Profile not found.', 'not_found')
  return data.user
}

export interface FxProfileStatusesOptions {
  /** Include the account's replies (X's "Tweets & replies" timeline). Default false. */
  withReplies?: boolean
  /**
   * Re-request a page that came back suspiciously short. X's timeline backend is
   * bimodal: the same cursor answers with a full page (~30) or with 0–1 items, and
   * the short answer is a transient miss, not the end of the timeline. Default 0.
   */
  retries?: number
  /** Cancels the request and any retry wait. */
  signal?: AbortSignal
}

/** A page this short is treated as an upstream miss when retries are allowed. */
export const FX_SHORT_PAGE = 8
/** Upstream 429s a page may wait out before the import gives up on it. */
const FX_THROTTLE_WAITS = 3
/** How long a pooled base sits out after answering 5xx. */
const FX_UPSTREAM_ERROR_COOLDOWN_MS = 60_000

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function fetchFxProfileStatuses(
  handle: string,
  cursor?: string,
  count = 20,
  options: FxProfileStatusesOptions = {},
): Promise<FxListResponse<FxTweet>> {
  const query = encodeQuery({ cursor, count, with_replies: options.withReplies ? 'true' : 'false' })
  const path = `2/profile/${encodeURIComponent(handle)}/statuses?${query}`
  let best: FxListResponse<FxTweet> = { results: [] }
  const attempts = 1 + Math.max(0, options.retries ?? 0)
  let throttled = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let data: Partial<FxListResponse<FxTweet>>
    options.signal?.throwIfAborted()
    try {
      data = await fxFetchJson<Partial<FxListResponse<FxTweet>>>(path, options.signal)
    } catch (error) {
      // A throttled page is worth a short wait when the caller asked for retries;
      // the loop still ends with the error so a hard limit surfaces as 503.
      if (error instanceof ConvertError && error.code === 'upstream_rate_limited' && options.retries && throttled < FX_THROTTLE_WAITS) {
        throttled += 1
        attempt -= 1
        if (error.retryAfter) await abortableDelay(Math.min(error.retryAfter, 10) * 1000, options.signal)
        continue
      }
      throw error
    }
    const page = { results: (data.results ?? []).map(normalizeTweet), cursor: data.cursor, attempts: attempt + 1 + throttled }
    if (page.results.length >= FX_SHORT_PAGE) return page
    if (page.results.length >= best.results.length) best = page
  }
  return { ...best, attempts: attempts + throttled }
}

export async function searchFxStatuses(
  queryText: string,
  feed: string,
  cursor?: string,
  count = 20,
): Promise<FxListResponse<FxTweet>> {
  const query = encodeQuery({ q: queryText, feed, cursor, count })
  const started = performance.now()
  let data: Partial<FxListResponse<FxTweet>>
  try {
    data = await fxFetchJson<Partial<FxListResponse<FxTweet>>>(`2/search?${query}`)
  } catch (error) {
    // FxTwitter answers `{code:404, results:[]}` when X's SearchTimeline gives it no
    // timeline at all (upstream account/session failure, see FxEmbed#2303). That is
    // an outage, not a missing post, so surface it as retryable.
    if (error instanceof ConvertError && error.code === 'not_found') {
      trackUpstream('fxtwitter', 'empty_response', 404, started)
      throw new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
    }
    throw error
  }
  return { results: (data.results ?? []).map(normalizeTweet), cursor: data.cursor }
}

export async function fetchFxConnections(
  handle: string,
  relation: 'followers' | 'following',
  cursor?: string,
  count = 20,
): Promise<FxListResponse<FxAuthor>> {
  const query = encodeQuery({ cursor, count })
  const data = await fxFetchJson<Partial<FxListResponse<FxAuthor>>>(
    `2/profile/${encodeURIComponent(handle)}/${relation}?${query}`,
  )
  return { results: data.results ?? [], cursor: data.cursor }
}

export async function fetchFxStatus(id: string): Promise<FxTweet> {
  const data = await fxFetch(`2/status/${encodeURIComponent(id)}`)
  const tweet = pickTweet(data)
  if (!tweet) {
    throw new ConvertError(404, 'Post not found.', 'not_found')
  }
  return tweet
}

export function getParentStatusId(tweet: FxTweet): string | undefined {
  const replyingTo = tweet.replying_to
  if (replyingTo && !Array.isArray(replyingTo)) {
    const status = replyingTo.status
    if (status) return String(status)
  }

  const fromStatus = tweet.replying_to_status?.[0]
  if (fromStatus) return String(fromStatus)

  return undefined
}

/** Walk parent replies from root through the given status id (inclusive). */
export async function fetchFxConversationChain(
  id: string,
): Promise<FxTweet[]> {
  const walked: FxTweet[] = []
  const seen = new Set<string>()
  let currentId: string | undefined = id

  while (currentId && walked.length < 100) {
    if (seen.has(currentId)) break
    seen.add(currentId)

    try {
      const tweet = await fetchFxStatus(currentId)
      walked.push(tweet)
      currentId = getParentStatusId(tweet)
    } catch (error) {
      if (error instanceof ConvertError && error.code === 'private_tweet') throw error
      break
    }
  }

  walked.reverse()
  return walked
}

export async function fetchFxThread(id: string): Promise<FxTweet[]> {
  const data = await fxFetch(`2/thread/${encodeURIComponent(id)}`)
  if (data.thread?.length) {
    return data.thread.map(normalizeTweet)
  }
  return [await fetchFxStatus(id)]
}

export type FxReplyRanking = 'likes' | 'recency'

/** Fetch ranked replies from FxTwitter's v2 conversation endpoint. */
export async function fetchFxConversationReplies(
  id: string,
  rankingMode: FxReplyRanking = 'likes',
  limit = 10,
): Promise<FxTweet[]> {
  const query = encodeQuery({ ranking_mode: rankingMode })
  const data = await fxFetchJson<FxConversationResponse>(
    `2/conversation/${encodeURIComponent(id)}?${query}`,
  )
  const results = (data.replies ?? data.results ?? data.tweets ?? data.conversation ?? [])
    .map(normalizeTweet)
    .filter((tweet) => getParentStatusId(tweet) === id)
  const timestamp = (tweet: FxTweet) => tweet.created_timestamp != null
    ? tweet.created_timestamp
    : Date.parse(tweet.created_at ?? '') || 0
  results.sort((a, b) => {
    const primary = rankingMode === 'likes'
      ? (b.likes ?? 0) - (a.likes ?? 0)
      : timestamp(b) - timestamp(a)
    return primary || timestamp(b) - timestamp(a) || String(a.id ?? '').localeCompare(String(b.id ?? ''))
  })
  return results.slice(0, limit)
}

/**
 * Full thread: FxTwitter thread endpoint (author threads + reply chains), with a
 * parent-walk fallback when the endpoint returns only the requested status.
 */
export async function fetchFxFullThread(id: string): Promise<FxTweet[]> {
  const fromThread = await fetchFxThread(id)
  if (fromThread.length > 1) {
    return fromThread
  }

  const tweet = fromThread[0] ?? (await fetchFxStatus(id))
  if (!getParentStatusId(tweet)) {
    return [tweet]
  }

  const chain = await fetchFxConversationChain(id)
  return chain.length > 0 ? chain : [tweet]
}
