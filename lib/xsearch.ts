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
  type Profile,
} from '@the-convocation/twitter-scraper'
import { ConvertError } from './errors.js'
import type { FxAuthor, FxListResponse, FxTweet } from './fxtwitter.js'
import { KEY_COUNTER, PUBLIC_COUNTER, poolSnapshot, resetPool, type PoolSnapshot } from './pool.js'
import { rateLimit, refundRateLimit } from './ratelimit.js'

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
 * X's authenticated SearchTimeline endpoint allows ~50 requests per account per
 * 15-minute window. We hold back a safety headroom below that ceiling so we cool
 * down on our own terms instead of eating X's 429 and its 15-minute penalty
 * (repeatedly hitting the ceiling is what risks an account lock).
 */
const X_SEARCH_CAP_PER_WINDOW = 50
/** Fraction of X's cap we keep in reserve (0.2 = 20% headroom → 40 usable). */
const SEARCH_HEADROOM = 0.2
const BUDGET_PER_SESSION = Math.floor(X_SEARCH_CAP_PER_WINDOW * (1 - SEARCH_HEADROOM))
const BUDGET_WINDOW_SEC = 15 * 60
/**
 * Fixed per-IP allowance for anonymous callers, deliberately pinned to the value
 * the two-account pool produced (floor(2 * 50 * 0.1) = 10) so public limits do
 * not change as we add accounts. New capacity is reserved for API-key callers.
 */
const PUBLIC_IP_BUDGET = 10

/** Who is making a search, for quota accounting. */
export type SearchCaller =
  | { kind: 'public'; ip?: string }
  | { kind: 'key'; id: string; limit: number }

function normalizeCaller(caller?: SearchCaller | string): SearchCaller | undefined {
  if (caller === undefined) return undefined
  return typeof caller === 'string' ? { kind: 'public', ip: caller } : caller
}

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
  resetPool()
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
  if (feed === 'photos' || feed === 'media') return SearchMode.Photos
  if (feed === 'videos') return SearchMode.Videos
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
export function searchXStatuses(queryText: string, feed: string, cursor?: string, count = 20, caller?: SearchCaller | string): Promise<FxListResponse<FxTweet>> {
  return withSearchSession(async (scraper) => {
    const page = await scraper.fetchSearchTweets(queryText, Math.min(count, 20), feedToMode(feed), cursor)
    return { results: page.tweets.map(tweetToFx), cursor: { bottom: page.next, top: page.previous } }
  }, normalizeCaller(caller))
}

export function profileToFx(profile: Profile): FxAuthor {
  return {
    id: profile.userId, name: profile.name, screen_name: profile.username,
    url: profile.username ? `https://x.com/${profile.username}` : profile.url,
    description: profile.biography, followers: profile.followersCount,
    following: profile.followingCount, statuses: profile.statusesCount ?? profile.tweetsCount,
    avatar_url: profile.avatar, banner_url: profile.banner, location: profile.location,
    protected: profile.isPrivate, verification: { verified: profile.isVerified || profile.isBlueVerified },
  }
}

export function searchXUsers(queryText: string, cursor?: string, count = 20, caller?: SearchCaller | string): Promise<FxListResponse<FxAuthor>> {
  return withSearchSession(async (scraper) => {
    const page = await scraper.fetchSearchProfiles(queryText, Math.min(count, 20), cursor)
    return { results: page.profiles.map(profileToFx), cursor: { bottom: page.next, top: page.previous } }
  }, normalizeCaller(caller))
}

/** Accounts configured (not permanently disabled), i.e. the capacity we can lean on. */
function activeAccountCount(): number {
  return sessionStates().filter((state) => !state.disabled).length
}

/** Accounts ready right now (not disabled and not cooling down). */
export function healthyAccountCount(): number {
  const now = Date.now()
  return sessionStates().filter((state) => !state.disabled && state.coolUntil <= now).length
}

/** Total account-backed search calls available across the pool per 15-minute window. */
export function poolCapacityPer15m(): number {
  return activeAccountCount() * BUDGET_PER_SESSION
}

/** Suggested default per-key allowance: about one-third of the total pool. */
export function defaultKeyLimitPer15m(): number {
  return Math.max(1, Math.floor(poolCapacityPer15m() / 3))
}

/** Live split of the pool between key reservations and the public (see `pool.ts`). */
export function searchPoolSnapshot(): Promise<PoolSnapshot> {
  return poolSnapshot(poolCapacityPer15m(), BUDGET_WINDOW_SEC)
}

/**
 * Capacity the public may draw right now. If the snapshot cannot be computed
 * (store outage) we fall back to the full pool rather than blocking everyone;
 * the per-session budgets still protect the accounts.
 */
async function publicCapNow(): Promise<number> {
  try {
    return (await searchPoolSnapshot()).publicCap
  } catch (error) {
    console.warn(`[xsearch] pool snapshot failed, using full capacity for public: ${String(error).slice(0, 120)}`)
    return poolCapacityPer15m()
  }
}

/** Snapshot of the rate model for the admin dashboard. */
export function searchRateModel(): {
  xCapPerAccount: number
  headroom: number
  perAccountBudget: number
  windowSec: number
  publicIpBudget: number
  activeAccounts: number
  healthyAccounts: number
  poolPer15m: number
  defaultKeyLimit: number
} {
  return {
    xCapPerAccount: X_SEARCH_CAP_PER_WINDOW,
    headroom: SEARCH_HEADROOM,
    perAccountBudget: BUDGET_PER_SESSION,
    windowSec: BUDGET_WINDOW_SEC,
    publicIpBudget: PUBLIC_IP_BUDGET,
    activeAccounts: activeAccountCount(),
    healthyAccounts: healthyAccountCount(),
    poolPer15m: poolCapacityPer15m(),
    defaultKeyLimit: defaultKeyLimitPer15m(),
  }
}

async function withSearchSession<T>(search: (scraper: Scraper) => Promise<T>, caller?: SearchCaller): Promise<T> {
  const now = Date.now()
  const candidates = sessionStates()
    .filter((state) => !state.disabled && state.coolUntil <= now)
    .sort((a, b) => a.coolUntil - b.coolUntil)
  if (candidates.length === 0) {
    throw new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
  }

  // Charge the caller once per search (numbered page walks call this once per page).
  // Checked before any account budget so rejected callers cannot consume account quota.
  if (caller?.kind === 'public') {
    // An unknown IP is still metered (as one shared "unknown" bucket) rather than left unaccounted.
    const ipKey = `xsearch:ip:${caller.ip || 'unknown'}`
    const fair = await rateLimit(ipKey, PUBLIC_IP_BUDGET, BUDGET_WINDOW_SEC, true)
    if (!fair.allowed) {
      throw new ConvertError(429, 'Account-backed search allowance reached for this IP. Retry after the current window.', 'rate_limited', fair.retryAfter)
    }
    // Shared public cap: whatever the pool has left after key usage and reservations.
    // Refund both counters on reject so retries do not burn capacity that keys release later in the window.
    const shared = await rateLimit(PUBLIC_COUNTER, await publicCapNow(), BUDGET_WINDOW_SEC, true, true)
    if (!shared.allowed) {
      await refundRateLimit(ipKey, BUDGET_WINDOW_SEC, fair.bucket)
      throw new ConvertError(429, 'Public search capacity is used up for this window. Retry after it resets.', 'rate_limited', shared.retryAfter)
    }
  } else if (caller?.kind === 'key') {
    // Refund rejected attempts: they must not count as pool usage in the snapshot.
    const fair = await rateLimit(KEY_COUNTER(caller.id), caller.limit, BUDGET_WINDOW_SEC, true, true)
    if (!fair.allowed) {
      throw new ConvertError(429, 'API key search allowance reached. Retry after the current window.', 'rate_limited', fair.retryAfter)
    }
  }

  let last: Failure | undefined
  for (const state of candidates) {
    const budget = await rateLimit(`xsearch:session:${state.session.id}`, BUDGET_PER_SESSION, BUDGET_WINDOW_SEC, true)
    if (!budget.allowed) {
      console.warn(`[xsearch] session ${state.session.id} budget spent (${BUDGET_PER_SESSION}/${BUDGET_WINDOW_SEC}s), resets in ${budget.retryAfter}s`)
      continue
    }
    try {
      const scraper = await scraperFor(state)
      return await search(scraper)
    } catch (error) {
      last = classify(error)
      if (last.kind === 'auth') state.disabled = last.detail
      else state.coolUntil = Date.now() + (last.kind === 'rate_limit' ? RATE_LIMIT_COOLDOWN_MS : TRANSIENT_COOLDOWN_MS)
      console.warn(`[xsearch] session ${state.session.id} ${last.kind}: ${last.detail}`)
    }
  }
  throw new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
}
