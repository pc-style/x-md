import {
  buildCacheKey,
  cacheControlHeader,
  type CacheStatus,
  vercelCacheControlHeader,
  withCache,
} from './cache.js'
import { ConvertError } from './errors.js'
import { firecrawlSearchConfigured, searchFirecrawlStatuses } from './firecrawl.js'
import { rateLimit } from './ratelimit.js'
import { searchXStatuses, searchXUsers, xsearchConfigured, type SearchCaller } from './xsearch.js'

/**
 * Per-IP ceiling on live /search lookups. Counted only when a request misses the
 * cache and is about to reach an upstream provider; cached hits are free.
 */
const SEARCH_IP_LIMIT = 5
const SEARCH_IP_WINDOW_SEC = 60
/** Per-key burst gate per minute; the real per-key allowance is enforced per 15 minutes in xsearch. */
const SEARCH_KEY_BURST_LIMIT = 30
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
const MAX_LIMIT = 20
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
function splitCursor(cursor: string | undefined): { source: BrowseSource; raw?: string } | undefined {
  if (!cursor) return undefined
  const match = cursor.match(/^(fxtwitter|xsearch):(.*)$/s)
  return match ? { source: match[1] as BrowseSource, raw: match[2] } : { source: 'fxtwitter', raw: cursor }
}

function tagCursor(source: BrowseSource, raw: string | undefined): string | undefined {
  return raw ? `${source}:${raw}` : undefined
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

async function walkPages<T>(
  page: number,
  cursor: string | undefined,
  fetchPage: (cursor?: string) => Promise<FxListResponse<T>>,
): Promise<FxListResponse<T>> {
  let current = cursor
  let result: FxListResponse<T> = { results: [] }
  const walks = cursor ? 1 : page
  for (let index = 0; index < walks; index += 1) {
    result = await fetchPage(current)
    if (index < walks - 1) {
      current = result.cursor?.bottom
      if (!current) return { results: [] }
    }
  }
  return result
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
    const query = input.q?.trim()
    if (!query) throw new ConvertError(400, 'Search query q is required.', 'missing_query')
    const requestedFeed = input.feed?.toLowerCase() ?? 'latest'
    const feed = requestedFeed === 'media' ? 'photos' : ['latest', 'top', 'photos', 'videos', 'users'].includes(requestedFeed) ? requestedFeed : 'latest'
    // Front-door burst gate for every live search provider (FxTwitter, own accounts,
    // Firecrawl): anonymous callers per IP, key callers per key with a looser burst.
    const caller: SearchCaller = input.caller ?? { kind: 'public', ip: input.ip ?? undefined }
    if (caller.kind === 'key') {
      const verdict = await rateLimit(`search:key:${caller.id}`, SEARCH_KEY_BURST_LIMIT, SEARCH_IP_WINDOW_SEC)
      if (!verdict.allowed) {
        throw new ConvertError(429, 'Too many live search lookups for this API key in a short burst. Slow down and retry shortly.', 'rate_limited', verdict.retryAfter)
      }
    } else if (caller.ip) {
      const verdict = await rateLimit(`search:ip:${caller.ip}`, SEARCH_IP_LIMIT, SEARCH_IP_WINDOW_SEC)
      if (!verdict.allowed) {
        throw new ConvertError(429, 'Too many live search lookups from this IP. Slow down and retry shortly.', 'rate_limited', verdict.retryAfter)
      }
    }
    const tagged = splitCursor(input.cursor ?? undefined)
    const render = (base: Omit<BrowseResult, 'markdown' | 'cache'>): BrowsePayload => ({ ...base, markdown: renderMarkdown(input, base, full) })

    if (feed === 'users') {
      if (!xsearchConfigured() || (tagged && tagged.source !== 'xsearch')) {
        throw new ConvertError(503, 'X user search is temporarily unavailable. Retry shortly.', 'search_unavailable')
      }
      const list = await walkPages(page, tagged?.raw, (cursor) => searchXUsers(query, cursor, limit, caller))
      return render({ resource, users: list.results.slice(0, limit), query, feed, page, limit, nextCursor: tagCursor('xsearch', list.cursor?.bottom), source: 'xsearch' })
    }

    const live: Array<{ source: BrowseSource; search: (cursor?: string) => Promise<FxListResponse<FxTweet>> }> = []
    if (['latest', 'top'].includes(feed) && Date.now() >= fxSearchDownUntil) live.push({ source: 'fxtwitter', search: (cursor) => searchFxStatuses(query, feed, cursor, limit) })
    if (xsearchConfigured()) live.push({ source: 'xsearch', search: (cursor) => searchXStatuses(query, feed, cursor, limit, caller) })
    // A continuation belongs to the provider that issued its cursor.
    const providers = tagged ? live.filter((provider) => provider.source === tagged.source) : live

    let outage: ConvertError | undefined
    for (const provider of providers) {
      try {
        const list = await walkPages(page, tagged?.raw, provider.search)
        return render({ resource, posts: list.results.slice(0, limit), query, feed, page, limit, nextCursor: tagCursor(provider.source, list.cursor?.bottom), source: provider.source })
      } catch (error) {
        if (!(error instanceof ConvertError && error.code === 'search_unavailable')) throw error
        if (provider.source === 'fxtwitter') fxSearchDownUntil = Date.now() + FX_SEARCH_BREAKER_MS
        outage = error
      }
    }

    // Web-index fallback only for a fresh first page: it has no notion of X cursors.
    if (['latest', 'top'].includes(feed) && page === 1 && !tagged && firecrawlSearchConfigured()) {
      const posts = await searchFirecrawlStatuses(query, feed, limit)
      return render({ resource, posts, query, feed, page, limit, source: 'firecrawl', degraded: true })
    }
    throw outage ?? new ConvertError(503, 'X search is temporarily unavailable upstream. Retry shortly.', 'search_unavailable')
  }

  const handle = validHandle(input.handle)
  if (resource === 'profile') {
    const [profile, list] = await Promise.all([
      fetchFxProfile(handle),
      walkPages(page, input.cursor ?? undefined, (cursor) => fetchFxProfileStatuses(handle, cursor, limit)),
    ])
    const posts = list.results.filter(isOriginalPost).slice(0, limit)
    const base = { resource, profile, posts, handle, page, limit, nextCursor: list.cursor?.bottom, source: 'fxtwitter' as const }
    return { ...base, markdown: renderMarkdown(input, base, full) }
  }

  const list = await walkPages(page, input.cursor ?? undefined, (cursor) => fetchFxConnections(handle, resource, cursor, limit))
  const base = { resource, users: list.results.slice(0, limit), handle, page, limit, nextCursor: list.cursor?.bottom, source: 'fxtwitter' as const }
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
  const limit = Math.min(positiveInt(input.limit, DEFAULT_LIMIT), MAX_LIMIT)
  const key = buildCacheKey({ v: 4, resource, handle: input.handle ?? '', q: input.q ?? '', feed: input.feed ?? '', cursor: input.cursor ?? '', page, limit, full: truthy(input.full) ? 1 : 0, format: input.format ?? 'markdown' })
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
