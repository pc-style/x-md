/**
 * Bulk profile history import.
 *
 * X only hands out timeline pages one cursor at a time, ~30 posts per page and
 * ~1.3 s per page, so a naive walk does 20–30 posts/s and a 2000-post history
 * takes over a minute. This module forges cursors (lib/fx-cursor.ts) to start
 * many chains at once: the requested range is cut into time windows sized from
 * the account's posting rate, each window is walked by its own chain until it
 * crosses into the next window, and the chains run concurrently. Measured on
 * api.fxtwitter.com: ~280 posts/s at concurrency 32, versus ~20 sequential.
 *
 * Upstream quirks this has to absorb:
 * - The same cursor answers with a full page or with 0–1 items at random. A
 *   short page is retried (`retries` in fetchFxProfileStatuses) before it is
 *   believed.
 * - A repost comes back as the *original* post (its id and `created_at`) with
 *   `reposted_by` set, while X positions it by repost time. Reposts therefore
 *   never decide where a window ends; they are kept wherever they are met and
 *   deduplicated by id.
 * - The "with replies" timeline includes other people's posts the account
 *   replied to. Only posts authored or reposted by the account are kept.
 * - X serves roughly the 3200 most recent timeline entries. Windows past that
 *   floor come back empty; three empty windows in a row past the newest
 *   non-empty one ends the import.
 */
import { ConvertError } from './errors.js'
import { cursorAt, snowflakeTime } from './fx-cursor.js'
import { FX_BASES, fetchFxProfile, fetchFxProfileStatuses, type FxAuthor, type FxProfileStatusesOptions, type FxTweet } from './fxtwitter.js'

export const IMPORT_DEFAULT_MAX_POSTS = 500
export const IMPORT_MAX_POSTS = 5000
export const IMPORT_DEFAULT_CONCURRENCY = 16
/** Per upstream base; a pool of N bases allows N times as many chains in flight. */
export const IMPORT_MAX_CONCURRENCY_PER_BASE = 32
export const IMPORT_MAX_CONCURRENCY = IMPORT_MAX_CONCURRENCY_PER_BASE * FX_BASES.length

/** Posts a window should hold: about one upstream page. Benchmarked (bench/RESULTS.md): 30 beat 60/120/240 on throughput at equal completeness, for ~30% more upstream requests. */
const WINDOW_TARGET_POSTS = 30
const WINDOW_MIN_HOURS = 1
const WINDOW_MAX_HOURS = 24 * 30
/** A window longer than this is split at its oldest seen post and the rest re-queued. */
const WINDOW_MAX_PAGES = 12
/** Empty windows past the newest non-empty one before we call it the timeline floor. */
const FLOOR_EMPTY_WINDOWS = 3
/** Own non-repost entries at the end of a page whose newest time decides whether the page crossed the window. */
const CROSSING_TAIL = 3
/** Hard cap on windows per import; at the 30-day maximum width this is decades. */
const MAX_WINDOWS = 1000
/** Short pages are bimodal (~30 or 0–1 items) with p≈0.2–0.3 per fetch; four retries puts a lost page below 0.3%. */
const PAGE_RETRIES = 4

export interface ImportInput {
  handle: string
  /** Oldest post to include. Omit to go as far back as upstream allows. */
  since?: Date
  /** Newest post to include. Defaults to now. */
  until?: Date
  maxPosts?: number
  withReplies?: boolean
  withReposts?: boolean
  onlyReplies?: boolean
  concurrency?: number
  /** Called once per post as it arrives, before the final sort. */
  onPost?: (post: FxTweet) => void
  signal?: AbortSignal
  /** Engine knobs for benchmarks; not exposed on the API. */
  tuning?: {
    /** Posts a window should hold (default 30). */
    windowTargetPosts?: number
    /** Short-page retries per upstream page (default 4; 0 disables). */
    pageRetries?: number
  }
}

export interface ImportMeta {
  handle: string
  count: number
  since?: string
  until: string
  /** ISO dates of the oldest and newest non-repost posts returned. */
  oldest?: string
  newest?: string
  /** `max_posts` was hit: continue with `until=<oldest>` for older history. */
  truncated: boolean
  /** Upstream stopped answering before `since`: X's ~3200 entry timeline floor. */
  floor_reached: boolean
  with_replies: boolean
  with_reposts: boolean
  only_replies: boolean
  concurrency: number
  windows: number
  pages: number
  retried_pages: number
  duration_ms: number
  /** Posts per hour estimated from the first page, which sized the windows. */
  estimated_rate_per_hour: number
  source: 'fxtwitter'
}

export interface ImportResult {
  profile?: FxAuthor
  posts: FxTweet[]
  meta: ImportMeta
}

interface Window {
  /** Newer bound, exclusive-ish: the chain starts just below this instant. */
  start: number
  /** Older bound, inclusive. */
  end: number
  /** Position from the newest window; subdivisions inherit their parent's. */
  index: number
}

/**
 * Process-wide cap on in-flight upstream timeline requests, shared by every
 * import running in this instance. FxTwitter allows about 1000 requests per
 * minute per IP; at ~1.3 s a page, 32 in flight is roughly 25 a second, which
 * one instance can sustain without tripping its edge limiter.
 */
let inFlight = 0
const waiting: Array<() => void> = []
async function governed<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= IMPORT_MAX_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  inFlight += 1
  try {
    return await task()
  } finally {
    inFlight -= 1
    waiting.shift()?.()
  }
}

export function isRepost(post: FxTweet): boolean {
  return Boolean(post.reposted_by)
}

export function isReply(post: FxTweet): boolean {
  return Boolean(post.replying_to && (!Array.isArray(post.replying_to) || post.replying_to.length > 0)) || Boolean(post.replying_to_status?.length)
}

/** Authored or reposted by `handle`; the with-replies timeline mixes in conversation parents. */
export function ownPost(post: FxTweet, handle: string): boolean {
  const h = handle.toLowerCase()
  return post.author?.screen_name?.toLowerCase() === h || post.reposted_by?.screen_name?.toLowerCase() === h
}

export function postTime(post: FxTweet): number {
  if (post.created_timestamp) return post.created_timestamp * 1000
  const parsed = Date.parse(post.created_at ?? '')
  if (Number.isFinite(parsed)) return parsed
  return post.id ? snowflakeTime(post.id) : 0
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback
  return Math.min(Math.floor(value as number), max)
}

/**
 * Timeline entries per hour from one page: every own entry counts (a repost
 * occupies a slot too), over the span of the own non-repost posts, which are the
 * ones whose time we know.
 */
export function estimateRate(page: FxTweet[], handle: string): number {
  const own = page.filter((post) => ownPost(post, handle))
  const times = own.filter((post) => !isRepost(post)).map(postTime).filter(Boolean).sort((a, b) => a - b)
  if (times.length < 2) return 1
  const hours = Math.max((times[times.length - 1] - times[0]) / 3_600_000, 0.25)
  return own.length / hours
}

export async function importProfilePosts(input: ImportInput): Promise<ImportResult> {
  const startedAt = Date.now()
  const handle = input.handle
  const withReplies = input.withReplies ?? true
  const withReposts = input.withReposts ?? true
  const onlyReplies = input.onlyReplies ?? false
  const maxPosts = clampInt(input.maxPosts, IMPORT_DEFAULT_MAX_POSTS, IMPORT_MAX_POSTS)
  const concurrency = clampInt(input.concurrency, IMPORT_DEFAULT_CONCURRENCY, IMPORT_MAX_CONCURRENCY)
  const until = input.until?.getTime() ?? Date.now()
  const since = input.since?.getTime()
  if (since !== undefined && since >= until) throw new ConvertError(400, '`since` must be earlier than `until`.', 'invalid_option')

  const timeline: FxProfileStatusesOptions = { withReplies: withReplies || onlyReplies, retries: input.tuning?.pageRetries ?? PAGE_RETRIES, signal: input.signal }
  const stats = { pages: 0, retried: 0, windows: 0 }
  const seen = new Map<string, FxTweet>()

  const wanted = (post: FxTweet): boolean => {
    if (!ownPost(post, handle)) return false
    if (isRepost(post)) return withReposts && !onlyReplies
    if (onlyReplies) return isReply(post)
    if (!withReplies && isReply(post)) return false
    return true
  }
  const keep = (post: FxTweet): void => {
    if (!post.id || seen.has(post.id) || !wanted(post)) return
    // Pages overlap the range edges; a post's own time decides membership,
    // except for reposts, which only carry the original's time.
    if (!isRepost(post)) {
      const at = postTime(post)
      if (at > until || (since !== undefined && at < since)) return
    }
    seen.set(post.id, post)
    // A stream gets the first `maxPosts` to arrive; the sorted JSON body gets the newest.
    if (seen.size <= maxPosts) input.onPost?.(post)
  }

  const fetchPage = async (cursor: string) => {
    input.signal?.throwIfAborted()
    const page = await governed(() => fetchFxProfileStatuses(handle, cursor, 100, timeline))
    stats.pages += page.attempts ?? 1
    stats.retried += (page.attempts ?? 1) - 1
    return page
  }

  // First page from the range top: sizes the windows and covers the newest slice.
  const [profile, first] = await Promise.all([
    fetchFxProfile(handle),
    fetchPage(cursorAt(until + 1)),
  ])
  const rate = estimateRate(first.results, handle)
  const windowMs = Math.min(Math.max((input.tuning?.windowTargetPosts ?? WINDOW_TARGET_POSTS) / rate, WINDOW_MIN_HOURS), WINDOW_MAX_HOURS) * 3_600_000

  // Lazy window generator plus a stack of subdivisions from over-long windows.
  let nextIndex = 0
  const extra: Window[] = []
  let newestNonEmpty = -1
  let emptyBeyond = 0
  let sinceReached = false
  let floorReached = false
  /** Discovery stopped because `maxPosts` was already collected: older history probably exists. */
  let cappedOut = false
  // Nothing predates the account, and no account has more windows than this;
  // both bound a `since`-less walk even if upstream never answers empty.
  const joined = Date.parse(profile.joined ?? '')
  const lowerBound = Math.max(since ?? 0, Number.isFinite(joined) ? joined : 0)
  const claim = (): Window | undefined => {
    const split = extra.pop()
    if (split) return split
    if (sinceReached || floorReached || nextIndex >= MAX_WINDOWS) return undefined
    if (seen.size >= maxPosts) {
      cappedOut = true
      return undefined
    }
    const start = until - nextIndex * windowMs
    let end = start - windowMs
    if (end <= lowerBound) {
      end = lowerBound
      sinceReached = true
    }
    if (start <= lowerBound) return undefined
    return { start, end, index: nextIndex++ }
  }

  const walk = async (window: Window): Promise<void> => {
    stats.windows += 1
    // A forged cursor starts strictly below its instant, so seek 1 ms past the bound to include it.
    let cursor = cursorAt(window.start + 1)
    let own = 0
    let oldestSeen = window.start
    // Upstream answered with nothing at all. A seek into a quiet stretch still
    // returns the entries below it; only a seek past the floor returns none.
    let barren = false
    for (let pages = 0; ; pages += 1) {
      const page = await fetchPage(cursor)
      if (page.results.length === 0) {
        barren = pages === 0
        break
      }
      // Pages are ordered by timeline position, not by `created_at`: X groups a
      // conversation so an older parent sits right above the newer reply that
      // put it there. So keep every own entry a page returns (windows overlap
      // slightly and `keep` dedupes) and decide that the chain has crossed the
      // window's older bound only from the page's tail, where position and time
      // agree again.
      const tail: number[] = []
      for (const post of page.results) {
        if (!ownPost(post, handle)) continue
        own += 1
        keep(post)
        if (isRepost(post)) continue
        tail.push(postTime(post))
        if (tail.length > CROSSING_TAIL) tail.shift()
      }
      const position = tail.length > 0 ? Math.max(...tail) : undefined
      if (position !== undefined) oldestSeen = Math.min(oldestSeen, position)
      const crossed = position !== undefined && position < window.end
      if (crossed || !page.cursor?.bottom) break
      if (pages + 1 >= WINDOW_MAX_PAGES) {
        // Rate was underestimated for this stretch; hand the rest to another chain,
        // but only when this one moved: a window that yielded no own original post
        // would otherwise be re-queued unchanged forever.
        if (oldestSeen < window.start && oldestSeen > window.end) extra.push({ start: oldestSeen, end: window.end, index: window.index })
        break
      }
      cursor = page.cursor.bottom
    }
    if (own > 0) {
      newestNonEmpty = Math.max(newestNonEmpty, window.index)
      // Quiet stretches are normal; only an unbroken run of empty windows past
      // every non-empty one is evidence of the floor.
      emptyBeyond = 0
    } else if (barren && window.index > newestNonEmpty) {
      emptyBeyond += 1
      if (emptyBeyond >= FLOOR_EMPTY_WINDOWS) floorReached = true
    }
  }

  for (const post of first.results) {
    if (postTime(post) <= until || isRepost(post)) keep(post)
  }

  // One chain failing stops the others instead of leaving them spending upstream capacity.
  const stopAll = new AbortController()
  const onOuterAbort = () => stopAll.abort(input.signal?.reason)
  input.signal?.addEventListener('abort', onOuterAbort, { once: true })
  timeline.signal = stopAll.signal
  const worker = async (): Promise<void> => {
    for (;;) {
      const window = claim()
      if (!window || stopAll.signal.aborted) return
      await walk(window)
    }
  }
  try {
    await Promise.all(Array.from({ length: concurrency }, worker))
  } catch (error) {
    stopAll.abort(error)
    throw error
  } finally {
    input.signal?.removeEventListener('abort', onOuterAbort)
  }

  // Newest first. Reposts sort by the original post's id, which is all upstream gives.
  let posts = [...seen.values()].sort((a, b) => (BigInt(b.id ?? 0) > BigInt(a.id ?? 0) ? 1 : -1))
  const truncated = posts.length > maxPosts || cappedOut
  if (posts.length > maxPosts) posts = posts.slice(0, maxPosts)
  const originals = posts.filter((post) => !isRepost(post))
  const iso = (ms: number) => new Date(ms).toISOString()

  return {
    profile,
    posts,
    meta: {
      handle,
      count: posts.length,
      since: since === undefined ? undefined : iso(since),
      until: iso(until),
      oldest: originals.length ? iso(postTime(originals[originals.length - 1])) : undefined,
      newest: originals.length ? iso(postTime(originals[0])) : undefined,
      truncated,
      floor_reached: floorReached,
      with_replies: withReplies,
      with_reposts: withReposts,
      only_replies: onlyReplies,
      concurrency,
      windows: stats.windows,
      pages: stats.pages,
      retried_pages: stats.retried,
      duration_ms: Date.now() - startedAt,
      estimated_rate_per_hour: Number(rate.toFixed(2)),
      source: 'fxtwitter',
    },
  }
}
