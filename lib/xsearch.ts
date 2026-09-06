/**
 * Own-account X search: SearchTimeline via @the-convocation/twitter-scraper
 * using our logged-in sessions. Second tier after FxTwitter, before Firecrawl.
 *
 * Sessions come from `accounts.local.json` (local dev) or `X_SEARCH_SESSIONS_JSON`
 * (Vercel). Health state is process-local: good enough for a single warm
 * function; a shared store is needed before this scales out.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ApiError,
  AuthenticationError,
  ErrorRateLimitStrategy,
  Scraper,
  SearchMode,
  type Tweet,
} from '@the-convocation/twitter-scraper'
import { ConvertError } from './errors.js'
import type { FxListResponse, FxTweet } from './fxtwitter.js'
import { rateLimit } from './ratelimit.js'

export interface XSession {
  id: string
  authToken: string
  ct0: string
}

interface SessionState {
  session: XSession
  scraper?: Scraper
  coolUntil: number
  disabled?: string
}

const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000
const TRANSIENT_COOLDOWN_MS = 30_000
const REQUEST_TIMEOUT_MS = 12_000
/**
 * X allows roughly 50 SearchTimeline calls per account per 15 minutes. Budget
 * below that across the pool so our own accounts never see X's 429.
 */
const BUDGET_PER_SESSION = 40
const BUDGET_WINDOW_SEC = 15 * 60

let states: SessionState[] | undefined

function parseSessions(raw: string, origin: string): XSession[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${origin} is not valid JSON.`)
  }
  if (!Array.isArray(parsed)) throw new Error(`${origin} must be a JSON array.`)
  const valid = /^[A-Za-z0-9_-]+$/
  return parsed.flatMap((entry, index): XSession[] => {
    const s = entry as Partial<XSession>
    if (typeof s.authToken !== 'string' || typeof s.ct0 !== 'string' || !valid.test(s.authToken) || !valid.test(s.ct0)) {
      console.warn(`[xsearch] skipping malformed session at index ${index} in ${origin}`)
      return []
    }
    return [{ id: typeof s.id === 'string' && s.id ? s.id : `session-${index}`, authToken: s.authToken, ct0: s.ct0 }]
  })
}

export function loadXSessions(): XSession[] {
  const file = path.join(process.cwd(), 'accounts.local.json')
  try {
    return parseSessions(readFileSync(file, 'utf8'), 'accounts.local.json')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const env = process.env.X_SEARCH_SESSIONS_JSON
  return env ? parseSessions(env, 'X_SEARCH_SESSIONS_JSON') : []
}

function sessionStates(): SessionState[] {
  states ??= loadXSessions().map((session) => ({ session, coolUntil: 0 }))
  return states
}

/** Test hook: replace the loaded sessions and reset health state. */
export function resetXSessions(sessions?: XSession[]): void {
  states = sessions?.map((session) => ({ session, coolUntil: 0 }))
}

export function xsearchConfigured(): boolean {
  return sessionStates().length > 0
}

async function scraperFor(state: SessionState): Promise<Scraper> {
  if (state.scraper) return state.scraper
  const scraper = new Scraper({
    rateLimitStrategy: new ErrorRateLimitStrategy(),
    fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  })
  await scraper.setCookies([
    `auth_token=${state.session.authToken}; Domain=.x.com; Path=/; Secure; HttpOnly`,
    `ct0=${state.session.ct0}; Domain=.x.com; Path=/; Secure`,
  ])
  state.scraper = scraper
  return scraper
}

function feedToMode(feed: string): SearchMode {
  if (feed === 'top') return SearchMode.Top
  if (feed === 'media') return SearchMode.Photos
  return SearchMode.Latest
}

/** Match FxTwitter's classic X timestamp format: `Sun Sep 06 16:27:32 +0000 2026`. */
function xDate(date: Date | undefined): string | undefined {
  if (!date || Number.isNaN(date.getTime())) return undefined
  const [weekday, day, month, year, time] = date.toUTCString().replace(',', '').split(' ')
  return `${weekday} ${month} ${day} ${time} +0000 ${year}`
}

export function tweetToFx(tweet: Tweet): FxTweet {
  const handle = tweet.username
  const photos = tweet.photos.map((photo) => ({ type: 'photo', url: photo.url, alt: photo.alt_text }))
  const videos = tweet.videos.map((video) => ({ type: 'video', url: video.url, thumbnail_url: video.preview }))
  const all = [...photos, ...videos]
  return {
    id: tweet.id,
    url: tweet.permanentUrl ?? (handle && tweet.id ? `https://x.com/${handle}/status/${tweet.id}` : undefined),
    text: tweet.text,
    created_at: xDate(tweet.timeParsed),
    created_timestamp: tweet.timestamp,
    author: handle ? { name: tweet.name ?? handle, screen_name: handle, url: `https://x.com/${handle}`, id: tweet.userId } : undefined,
    replies: tweet.replies,
    retweets: tweet.retweets,
    likes: tweet.likes,
    views: tweet.views,
    bookmarks: tweet.bookmarkCount,
    replying_to_status: tweet.inReplyToStatusId ? [tweet.inReplyToStatusId] : undefined,
    quote: tweet.quotedStatus ? tweetToFx(tweet.quotedStatus) : undefined,
    possibly_sensitive: tweet.sensitiveContent,
    media: all.length ? { photos, videos, all } : undefined,
  }
}

type Failure = { kind: 'rate_limit' | 'auth' | 'transient'; detail: string }

function classify(error: unknown): Failure {
  if (error instanceof AuthenticationError) return { kind: 'auth', detail: error.message }
  if (error instanceof ApiError) {
    const status = error.response.status
    if (status === 429) return { kind: 'rate_limit', detail: `HTTP 429` }
    if (status === 401 || status === 403) return { kind: 'auth', detail: `HTTP ${status}` }
    return { kind: 'transient', detail: `HTTP ${status}` }
  }
  const message = String(error)
  if (/rate limit/i.test(message)) return { kind: 'rate_limit', detail: message.slice(0, 120) }
  return { kind: 'transient', detail: message.slice(0, 120) }
}

/**
 * Search X with the healthiest own account. Tries each available session at
 * most once; a rate limit or auth failure takes that session out of rotation.
 */
export async function searchXStatuses(
  queryText: string,
  feed: string,
  cursor?: string,
  count = 20,
): Promise<FxListResponse<FxTweet>> {
  const now = Date.now()
  const candidates = sessionStates()
    .filter((state) => !state.disabled && state.coolUntil <= now)
    .sort((a, b) => a.coolUntil - b.coolUntil)
  if (candidates.length === 0) {
    throw new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
  }

  const budget = await rateLimit('xsearch:global', BUDGET_PER_SESSION * candidates.length, BUDGET_WINDOW_SEC)
  if (!budget.allowed) {
    console.warn(`[xsearch] pool budget exhausted (${budget.limit}/${BUDGET_WINDOW_SEC}s); resets in ${budget.retryAfter}s`)
    throw new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
  }

  let last: Failure | undefined
  for (const state of candidates) {
    try {
      const scraper = await scraperFor(state)
      const page = await scraper.fetchSearchTweets(queryText, count, feedToMode(feed), cursor)
      return { results: page.tweets.map(tweetToFx), cursor: { bottom: page.next, top: page.previous } }
    } catch (error) {
      last = classify(error)
      if (last.kind === 'auth') state.disabled = last.detail
      else state.coolUntil = Date.now() + (last.kind === 'rate_limit' ? RATE_LIMIT_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS)
      console.warn(`[xsearch] session ${state.session.id} ${last.kind}: ${last.detail}`)
    }
  }
  throw new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
}
