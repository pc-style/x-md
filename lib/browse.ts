import { trackRateLimit, trackFallback } from './server-events.js'
import {
  buildCacheKey,
  cacheControlHeader,
  type CacheStatus,
  vercelCacheControlHeader,
  withCache,
} from './cache.js'
import { ConvertError } from './errors.js'
import { firecrawlSearchConfigured, searchFirecrawlStatuses } from './firecrawl.js'
import { SEARCH_IP, SEARCH_KEY, searchIpKey, searchKeyKey } from './quotas.js'
import { rateLimit } from './ratelimit.js'
import { searchXStatuses, searchXUsers, xsearchConfigured, type SearchCaller } from './xsearch.js'
import { cursorAt, decodeTimelineCursor, encodeTimelineCursor, parseDateInput } from './fx-cursor.js'
import { isReply, isRepost, ownPost } from './import.js'
import {
  fetchFxConnections,
  fetchFxProfile,
  fetchFxProfileStatuses,
  searchFxStatuses,
  type FxAuthor,
  type FxListResponse,
  type FxTweet,
} from './fxtwitter.js'

const DEFAULT_LIMIT = 20
/** Every list is assembled from as many upstream pages as needed (~20–70 items each). */
const MAX_LIMIT = 100
const PROFILE_MAX_LIMIT = 100
const PROFILE_MAX_UPSTREAM_PAGES = 8
/** Upstream pages one search or connections request may spend. */
const LIST_MAX_UPSTREAM_PAGES = 6
/** Own-account search feeds answer one upstream page per request to protect the shared pool. */
const ACCOUNT_SEARCH_LIMIT = 20
const MAX_PAGE = 10
/** Degraded search results are re-checked quickly so recovery of the live source shows up. */
const DEGRADED_TTL_MS = 60_000
const DEGRADED_NOTE = 'Live X search is unavailable right now. These are web-indexed snippets of x.com posts, not a live timeline: ordering and coverage differ, snippet text may be truncated, and no metrics are available.'

export type BrowseResource = 'profile' | 'search' | 'followers' | 'following'
export type BrowseSource = 'fxtwitter' | 'xsearch' | 'firecrawl'

/** After FxTwitter search fails, skip it for this long so requests go straight to the next tier. */
const FX_SEARCH_BREAKER_MS = 60_000
let fxSearchDownUntil = 0

/** Test hook. */
export function resetSearchBreaker(): void {
  fxSearchDownUntil = 0
}

/**
 * Search cursors are tagged with the provider that issued them (`xsearch:abc`).
 * Untagged cursors predate tagging and belong to FxTwitter.
 */
function splitCursor(cursor: string | undefined): { source: BrowseSource; raw?: string; offset: number } | undefined {
  if (!cursor) return undefined
  const match = cursor.match(/^(fxtwitter|xsearch):(.*)$/s)
  const { raw, offset } = splitOffset(match ? match[2] : cursor)
  return { source: match ? (match[1] as BrowseSource) : 'fxtwitter', raw, offset }
}

function tagCursor(source: BrowseSource, position: ListPosition | undefined): string | undefined {
  const raw = joinOffset(position)
  return raw === undefined ? undefined : `${source}:${raw}`
}

/**
 * A list position: an upstream cursor plus how many items of that page were
 * already served. Blocks are cut exactly at `limit`; when the cut falls inside
 * an upstream page the continuation re-reads that page and skips `offset`
 * items, so nothing is lost or repeated.
 */
export interface ListPosition {
  cursor?: string
  offset: number
}

function splitOffset(value: string | undefined): { raw?: string; offset: number } {
  const match = value?.match(/^(.*)@(\d+)$/s)
  if (!match) return { raw: value || undefined, offset: 0 }
  return { raw: match[1] || undefined, offset: Number.parseInt(match[2], 10) }
}

function joinOffset(position: ListPosition | undefined): string | undefined {
  if (!position) return undefined
  if (position.offset > 0) return `${position.cursor ?? ''}@${position.offset}`
  return position.cursor
}

/**
 * One block of exactly `limit` items from a cursor-paged upstream list, starting
 * at `start`. Page mode walks `page` such blocks and returns the last one.
 */
async function collectList<T>(
  page: number,
  start: ListPosition | undefined,
  limit: number,
  fetchPage: (cursor?: string) => Promise<FxListResponse<T>>,
  maxUpstreamPages = LIST_MAX_UPSTREAM_PAGES,
): Promise<{ results: T[]; next?: ListPosition }> {
  const blocks = start ? 1 : page
  let position: ListPosition | undefined = start ?? { offset: 0 }
  let results: T[] = []
  let budget = maxUpstreamPages + (blocks - 1) * 2
  for (let index = 0; index < blocks; index += 1) {
    results = []
    let next: ListPosition | undefined
    while (position && budget > 0 && results.length < limit) {
      budget -= 1
      const upstream = await fetchPage(position.cursor)
      const items = upstream.results.slice(position.offset)
      const take = Math.min(items.length, limit - results.length)
      results.push(...items.slice(0, take))
      const consumed = position.offset + take
      if (consumed < upstream.results.length) {
        next = { cursor: position.cursor, offset: consumed }
        break
      }
      next = upstream.cursor?.bottom && upstream.results.length > 0 ? { cursor: upstream.cursor.bottom, offset: 0 } : undefined
      position = next
    }
    position = next
    if (index < blocks - 1 && !position) return { results: [] }
  }
  return { results, next: position }
}

export interface BrowseInput {
  resource?: string | null
  handle?: string | null
  q?: string | null
  feed?: string | null
  cursor?: string | null
  page?: string | number | null
  limit?: string | number | null
  full?: string | boolean | null
  format?: string | null
  nocache?: string | boolean | null
  /** Profile only: include the account's replies (default false). */
  with_replies?: string | boolean | null
  /** Profile only: include reposts (default false). */
  with_reposts?: string | boolean | null
  /** Profile: start below this date instead of the newest post. Search: newest post to match. ISO date or unix timestamp. */
  until?: string | null
  /** Search only: oldest post to match. */
  since?: string | null
  /** Client IP for per-IP limiting of live lookups (anonymous callers). */
  ip?: string | null
  /** Resolved caller identity. Defaults to a public caller keyed by `ip`. */
  caller?: SearchCaller
}

export interface BrowseResult {
  resource: BrowseResource
  profile?: FxAuthor
  posts?: FxTweet[]
  users?: FxAuthor[]
  query?: string
  feed?: string
  handle?: string
  page: number
  limit: number
  nextCursor?: string
  /** Profile only: which timeline entries were kept. */
  with_replies?: boolean
  with_reposts?: boolean
  source: BrowseSource
  /** Set when a fallback source served the result instead of live X data. */
  degraded?: boolean
  markdown: string
  cache: CacheStatus
}

function positiveInt(value: string | number | null | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function truthy(value: string | boolean | null | undefined): boolean {
  return value === true || value === 'true' || value === '1'
}

function validHandle(value: string | null | undefined): string {
  const handle = (value ?? '').replace(/^@/, '')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
    throw new ConvertError(400, 'A valid X handle is required.', 'invalid_handle')
  }
  return handle
}

export function isOriginalPost(post: FxTweet): boolean {
  return !post.replying_to && !post.replying_to_status?.length && !post.reposted_by
}

/**
 * One profile page of exactly `limit` kept posts, assembled from as many
 * upstream pages as it takes. The continuation cursor is forged at the last
 * returned original post (lib/fx-cursor.ts), so the next page starts right
 * after it instead of at an upstream page boundary. Page mode walks `page`
 * such blocks and returns the last one.
 */
async function collectProfilePosts(
  handle: string,
  page: number,
  cursor: string | undefined,
  limit: number,
  withReplies: boolean,
  withReposts: boolean,
): Promise<FxListResponse<FxTweet>> {
  const keep = (post: FxTweet): boolean => {
    if (!ownPost(post, handle)) return false
    if (isRepost(post)) return withReposts
    if (isReply(post)) return withReplies
    return true
  }
  const blocks = cursor ? 1 : page
  let current = cursor
  let block: FxTweet[] = []
  let next: string | undefined
  // One upstream budget for the whole request: page mode walks earlier blocks
  // too, and must not turn `page=10&limit=100` into dozens of sequential calls.
  let budget = PROFILE_MAX_UPSTREAM_PAGES + (blocks - 1) * 2
  for (let index = 0; index < blocks; index += 1) {
    block = []
    next = undefined
    const seen = new Set<string>()
    /** Where each upstream page ended in `block`, with the real cursor that follows it. */
    const pageEnds: Array<{ count: number; cursor?: string }> = []
    for (; budget > 0 && block.length < limit; budget -= 1) {
      const upstream = await fetchFxProfileStatuses(handle, current, limit, { withReplies, retries: 2 })
      for (const post of upstream.results) {
        if (!post.id || seen.has(post.id) || !keep(post)) continue
        seen.add(post.id)
        block.push(post)
      }
      next = upstream.cursor?.bottom
      pageEnds.push({ count: block.length, cursor: next })
      if (!next || upstream.results.length === 0) break
      current = next
    }
    if (block.length > limit) {
      // Cut at the last original inside the limit and forge the continuation
      // there: reposts carry the original's id, not their timeline position, so
      // a block never ends on one. When the whole overfull stretch is reposts,
      // fall back to the last complete upstream page and its real cursor.
      let cut = limit
      while (cut > 0 && isRepost(block[cut - 1])) cut -= 1
      const lastPageStart = pageEnds.length > 1 ? pageEnds[pageEnds.length - 2].count : 0
      if (cut > lastPageStart) {
        block = block.slice(0, cut)
        const last = block[block.length - 1]
        const decoded = next ? decodeTimelineCursor(next) : undefined
        next = encodeTimelineCursor({ issuedAt: decoded?.issuedAt ?? decodeTimelineCursor(cursorAt(Date.now()))!.issuedAt, sortIndex: BigInt(last.id!), direction: 2 })
      } else if (lastPageStart > 0) {
        block = block.slice(0, lastPageStart)
        next = pageEnds[pageEnds.length - 2].cursor
      }
    }
    if (index < blocks - 1) {
      current = next
      if (!current) return { results: [] }
    }
  }
  return { results: block, cursor: next ? { bottom: next } : undefined }
}

function postLine(post: FxTweet, full: boolean): string {
  const handle = post.author?.screen_name
  const who = handle ? `[@${handle}](https://x.com/${handle})` : post.author?.name ?? 'unknown'
  const url = post.url ?? (post.id ? `https://x.com/${handle ?? 'i'}/status/${post.id}` : `https://x.com/${handle ?? ''}`)
  const text = (post.text ?? '').replace(/\s+/g, ' ').trim()
  const metrics = full ? ` — ${post.likes ?? 0} likes, ${post.retweets ?? 0} reposts, ${post.replies ?? 0} replies` : ''
  const date = full && post.created_at ? ` (${post.created_at})` : ''
  return `- ${who}: ${text}${date}${metrics} [Source](${url})`
}

function userLine(user: FxAuthor, full: boolean): string {
  const handle = user.screen_name ?? 'unknown'
  const details = full ? ` — ${user.followers ?? 0} followers${user.description ? ` — ${user.description.replace(/\s+/g, ' ')}` : ''}` : ''
  return `- [${user.name ?? `@${handle}`} (@${handle})](https://x.com/${handle})${details}`
}

function continuation(input: BrowseInput, result: Omit<BrowseResult, 'markdown' | 'cache'>): string | undefined {
  if (!result.nextCursor) return undefined
  const controls = new URLSearchParams()
  if (result.limit !== DEFAULT_LIMIT) controls.set('limit', String(result.limit))
  if (truthy(input.full)) controls.set('full', 'true')
  if (input.format) controls.set('format', input.format)
  if (result.with_replies) controls.set('with_replies', 'true')
  if (result.with_reposts) controls.set('with_reposts', 'true')
  if (['profile', 'search'].includes(result.resource) && input.until) controls.set('until', input.until)
  if (result.resource === 'search' && input.since) controls.set('since', input.since)
  let path: string
  if (result.resource === 'search') {
    controls.set('q', result.query ?? '')
    if (result.feed) controls.set('feed', result.feed)
    path = '/search'
  } else {
    path = `/${result.handle}${result.resource === 'profile' ? '' : `/${result.resource}`}`
  }
  const cursorParams = new URLSearchParams(controls)
  cursorParams.set('cursor', result.nextCursor)
  const pageParams = new URLSearchParams(controls)
  pageParams.set('page', String(result.page + 1))
  return `[Continue →](${path}?${cursorParams.toString()}) · [Next page (${result.page + 1}) →](${path}?${pageParams.toString()})`
}

function renderMarkdown(input: BrowseInput, result: Omit<BrowseResult, 'markdown' | 'cache'>, full: boolean): string {
  const lines: string[] = []
  if (result.resource === 'profile' && result.profile) {
    const p = result.profile
    const handle = p.screen_name ?? result.handle ?? 'unknown'
    lines.push(`# [${p.name ?? `@${handle}`} (@${handle})](https://x.com/${handle})`, '')
    if (p.description) lines.push(p.description, '')
    if (full) lines.push(`Followers: ${p.followers ?? 0} · Following: ${p.following ?? 0} · Posts: ${p.statuses ?? 0}`, '')
    lines.push('## Latest posts', ...(result.posts ?? []).map((post) => postLine(post, full)))
  } else if (result.resource === 'search') {
    lines.push(`# X search: ${result.query}`, '')
    if (result.degraded) lines.push(`> ${DEGRADED_NOTE}`, '')
    lines.push(...(result.users ?? []).map((user) => userLine(user, full)))
    lines.push(...(result.posts ?? []).map((post) => postLine(post, result.degraded ? false : full)))
  } else {
    lines.push(`# @${result.handle} ${result.resource}`, '', ...(result.users ?? []).map((user) => userLine(user, full)))
  }
  const next = continuation(input, result)
  if (next) lines.push('', next)
  return `${lines.join('\n').trim()}\n`
}

type BrowsePayload = Omit<BrowseResult, 'cache'>

async function browseUncached(input: BrowseInput, resource: BrowseResource, page: number, limit: number): Promise<BrowsePayload> {
  const full = truthy(input.full)
  if (resource === 'search') {
    const typed = input.q?.trim()
    if (!typed) throw new ConvertError(400, 'Search query q is required.', 'missing_query')
    // Date bounds ride inside the query as X operators, which every provider honours.
    const sinceDate = input.since ? parseDateInput(input.since) : undefined
    const untilDate = input.until ? parseDateInput(input.until) : undefined
    if (input.since && !sinceDate) throw new ConvertError(400, '`since` must be an ISO date, ISO datetime, or unix timestamp.', 'invalid_option')
    if (input.until && !untilDate) throw new ConvertError(400, '`until` must be an ISO date, ISO datetime, or unix timestamp.', 'invalid_option')
    if (sinceDate && untilDate && sinceDate >= untilDate) throw new ConvertError(400, '`since` must be earlier than `until`.', 'invalid_option')
    const query = [typed, sinceDate ? `since_time:${Math.floor(sinceDate.getTime() / 1000)}` : '', untilDate ? `until_time:${Math.floor(untilDate.getTime() / 1000)}` : ''].filter(Boolean).join(' ')
    const requestedFeed = input.feed?.toLowerCase() ?? 'latest'
    const feed = requestedFeed === 'media' ? 'photos' : ['latest', 'top', 'photos', 'videos', 'users'].includes(requestedFeed) ? requestedFeed : 'latest'
    // Front-door burst gate for every live search provider (FxTwitter, own accounts,
    // Firecrawl): anonymous callers per IP, key callers per key with a looser burst.
    const caller: SearchCaller = input.caller ?? { kind: 'public', ip: input.ip ?? undefined }
    if (caller.kind === 'key') {
      const verdict = await rateLimit(searchKeyKey(caller.id), SEARCH_KEY.quota, SEARCH_KEY.windowSec)
      if (!verdict.allowed) {
        trackRateLimit('key')
        throw new ConvertError(429, 'Too many live search lookups for this API key in a short burst. Slow down and retry shortly.', 'rate_limited', verdict.retryAfter, SEARCH_KEY.name)
      }
    } else if (caller.ip) {
      const verdict = await rateLimit(searchIpKey(caller.ip), SEARCH_IP.quota, SEARCH_IP.windowSec)
      if (!verdict.allowed) {
        trackRateLimit('ip')
        throw new ConvertError(429, 'Too many live search lookups from this IP. Slow down and retry shortly.', 'rate_limited', verdict.retryAfter, SEARCH_IP.name)
      }
    }
    const tagged = splitCursor(input.cursor ?? undefined)
    const render = (base: Omit<BrowseResult, 'markdown' | 'cache'>): BrowsePayload => ({ ...base, markdown: renderMarkdown(input, base, full) })

    if (feed === 'users') {
      if (!xsearchConfigured() || (tagged && tagged.source !== 'xsearch')) {
        throw new ConvertError(503, 'X user search is temporarily unavailable. Retry shortly.', 'search_unavailable')
      }
      // Own-account searches spend a scarce per-account budget: one upstream page per request.
      const accountLimit = Math.min(limit, ACCOUNT_SEARCH_LIMIT)
      const list = await collectList(page, tagged ? { cursor: tagged.raw, offset: tagged.offset } : undefined, accountLimit, (cursor) => searchXUsers(query, cursor, accountLimit, caller), 1)
      return render({ resource, users: list.results, query: typed, feed, page, limit: accountLimit, nextCursor: tagCursor('xsearch', list.next), source: 'xsearch' })
    }

    const accountLimit = Math.min(limit, ACCOUNT_SEARCH_LIMIT)
    const live: Array<{ source: BrowseSource; limit: number; pages: number; search: (cursor?: string) => Promise<FxListResponse<FxTweet>> }> = []
    if (['latest', 'top'].includes(feed) && Date.now() >= fxSearchDownUntil) live.push({ source: 'fxtwitter', limit, pages: LIST_MAX_UPSTREAM_PAGES, search: (cursor) => searchFxStatuses(query, feed, cursor, limit) })
    // Own-account searches spend a scarce per-account budget: one upstream page per request.
    if (xsearchConfigured()) live.push({ source: 'xsearch', limit: accountLimit, pages: 1, search: (cursor) => searchXStatuses(query, feed, cursor, accountLimit, caller) })
    // A continuation belongs to the provider that issued its cursor.
    const providers = tagged ? live.filter((provider) => provider.source === tagged.source) : live

    let outage: ConvertError | undefined
    for (const provider of providers) {
      const isFallback = outage || (provider.source === 'xsearch' && ['latest', 'top'].includes(feed) && !tagged && Date.now() < fxSearchDownUntil)
      try {
        const list = await collectList(page, tagged ? { cursor: tagged.raw, offset: tagged.offset } : undefined, provider.limit, provider.search, provider.pages)
        // Report only once the fallback has served the request.
        if (isFallback) trackFallback('fxtwitter', provider.source, outage ? 'primary_error' : 'primary_unavailable')
        return render({ resource, posts: list.results, query: typed, feed, page, limit: provider.limit, nextCursor: tagCursor(provider.source, list.next), source: provider.source })
      } catch (error) {
        if (!(error instanceof ConvertError && error.code === 'search_unavailable')) throw error
        if (provider.source === 'fxtwitter') fxSearchDownUntil = Date.now() + FX_SEARCH_BREAKER_MS
        outage = error
      }
    }

    // Web-index fallback only for a fresh first page: it has no notion of X cursors.
    if (['latest', 'top'].includes(feed) && page === 1 && !tagged && firecrawlSearchConfigured()) {
      const posts = await searchFirecrawlStatuses(query, feed, limit)
      trackFallback(xsearchConfigured() ? 'xsearch' : 'fxtwitter', 'firecrawl', outage ? 'primary_error' : 'primary_unavailable')
      return render({ resource, posts, query: typed, feed, page, limit, source: 'firecrawl', degraded: true })
    }
    throw outage ?? new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
  }

  const handle = validHandle(input.handle)
  if (resource === 'profile') {
    const withReplies = truthy(input.with_replies)
    const withReposts = truthy(input.with_reposts)
    const until = input.until ? parseDateInput(input.until) : undefined
    if (input.until && !until) throw new ConvertError(400, '`until` must be an ISO date, ISO datetime, or unix timestamp.', 'invalid_option')
    const [profile, list] = await Promise.all([
      fetchFxProfile(handle),
      collectProfilePosts(handle, page, input.cursor ?? (until ? cursorAt(until) : undefined), limit, withReplies, withReposts),
    ])
    const base = { resource, profile, posts: list.results, handle, page, limit, nextCursor: list.cursor?.bottom, with_replies: withReplies, with_reposts: withReposts, source: 'fxtwitter' as const }
    return { ...base, markdown: renderMarkdown(input, base, full) }
  }

  const start = input.cursor ? (({ raw, offset }) => ({ cursor: raw, offset }))(splitOffset(input.cursor)) : undefined
  const list = await collectList(page, start, limit, (cursor) => fetchFxConnections(handle, resource, cursor, limit))
  const base = { resource, users: list.results, handle, page, limit, nextCursor: joinOffset(list.next), source: 'fxtwitter' as const }
  return { ...base, markdown: renderMarkdown(input, base, full) }
}

export async function browse(input: BrowseInput): Promise<BrowseResult> {
  const resource = input.resource as BrowseResource
  if (!['profile', 'search', 'followers', 'following'].includes(resource)) {
    throw new ConvertError(400, 'Unsupported browse resource.', 'invalid_resource')
  }
  if (input.format && input.format !== 'markdown' && input.format !== 'json') {
    throw new ConvertError(
      400,
      'Browse `format` must be `markdown` or `json`.',
      'invalid_format',
    )
  }
  const page = Math.min(positiveInt(input.page, 1), MAX_PAGE)
  const limit = Math.min(positiveInt(input.limit, DEFAULT_LIMIT), resource === 'profile' ? PROFILE_MAX_LIMIT : MAX_LIMIT)
  const key = buildCacheKey({ v: 5, resource, handle: input.handle ?? '', q: input.q ?? '', feed: input.feed ?? '', cursor: input.cursor ?? '', until: input.until ?? '', since: input.since ?? '', page, limit, full: truthy(input.full) ? 1 : 0, replies: truthy(input.with_replies) ? 1 : 0, reposts: truthy(input.with_reposts) ? 1 : 0, format: input.format ?? 'markdown' })
  const cached = await withCache(
    key,
    truthy(input.nocache),
    () => browseUncached(input, resource, page, limit),
    (value) => (value.degraded ? DEGRADED_TTL_MS : undefined),
  )
  return { ...cached.value, cache: cached.status }
}

export function browseResponse(result: BrowseResult, asJson: boolean): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    'Content-Type': asJson ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
    Vary: 'Accept',
    'X-Source': result.source,
    'X-Cache': result.cache.toUpperCase(),
    'X-Browse-Resource': result.resource,
    'X-Result-Count': String(result.posts?.length ?? result.users?.length ?? 0),
  }
  if (result.degraded) headers['X-Search-Degraded'] = 'true'
  if (result.cache !== 'bypass') {
    headers['Cache-Control'] = cacheControlHeader()
    headers['Vercel-CDN-Cache-Control'] = result.degraded
      ? vercelCacheControlHeader(DEGRADED_TTL_MS / 1000)
      : vercelCacheControlHeader()
  }
  return { status: 200, headers, body: asJson ? JSON.stringify(result) : result.markdown }
}
