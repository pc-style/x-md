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
 * - The same span reads differently from cursor to cursor: a reply folded into
 *   a later reply's conversation is left out of every page that holds both, and
 *   shows only from a page that starts between them. So the walk cuts and
 *   follows windows exactly as the plain pool of chains does, from the same
 *   pages at the same moments, and stops early only once nothing still to be
 *   asked could change the answer.
 */
import { withImportSlot } from './import-admission.js'
import { ConvertError } from './errors.js'
import { UPSTREAM_CANCELLED } from './server-events.js'
import { cursorAt, decodeTimelineCursor, snowflakeAt, snowflakeTime } from './fx-cursor.js'
import { FX_BASES, FX_SHORT_PAGE, confirmedProfileMiss, fetchFxProfile, fetchFxProfileStatuses, isFxAccountMissing, isFxBaseFailure, isFxProfileMiss, type FxAuthor, type FxProfileStatusesOptions, type FxTweet } from './fxtwitter.js'

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
/**
 * Copies of the first page in flight at once. Every walk waits on that page, and
 * a short answer is both random and slow, so two copies up front cut its median
 * and most of its tail for one extra request (see fetchFxProfileStatuses). A
 * third copy bought ~5% on the median for half again the requests (simulated,
 * scripts/bench-posts.ts --sim).
 */
const FIRST_PAGE_HEDGE = 2
/**
 * Profile requests in flight at once, and per import. The profile endpoint
 * answers a spurious NOT_FOUND about as often as a page comes back short, and
 * a miss takes ~2.5 s to arrive against ~1.2 s for an answer, which on a warm
 * request is longer than the walk; a third copy goes out only when both miss.
 */
const PROFILE_COPIES = 2
const PROFILE_ATTEMPTS = 3
/**
 * Copies of a window page that may hold part of the answer, for walks up to
 * HEDGED_WALK_MAX_POSTS or over a range up to HEDGED_RANGE_MAX_MS (a filtered
 * top-up walks with the largest cap): a short answer waits on its slowest
 * page. A deep walk keeps one copy per page, as its many chains already hide a
 * slow one and doubling it would double its upstream cost.
 */
const WINDOW_PAGE_HEDGE = 2
const HEDGED_WALK_MAX_POSTS = IMPORT_DEFAULT_MAX_POSTS
const HEDGED_RANGE_MAX_MS = 24 * 3_600_000

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
    /** Copies in flight for pages after the first (default 2 up to HEDGED_WALK_MAX_POSTS or over a range up to HEDGED_RANGE_MAX_MS, else 1). */
    hedge?: number
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
  covered_since?: string
  next_until?: string
  with_replies: boolean
  with_reposts: boolean
  only_replies: boolean
  concurrency: number
  windows: number
  pages: number
  retried_pages: number
  /** The walk skipped a page after bounded retries; this range is incomplete. */
  warnings?: Array<'page_missing'>
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
  /** Sort index the chain's next page starts below. */
  head: bigint
  /** Oldest crossing position seen so far; a split or a retry after a miss restarts here. */
  oldestSeen: number
}

/**
 * Process-wide cap on in-flight upstream timeline requests, shared by every
 * import running in this instance. FxTwitter allows about 1000 requests per
 * minute per IP; at ~1.3 s a page, 32 in flight is roughly 25 a second, which
 * one instance can sustain without tripping its edge limiter. It gates each
 * request, so hedged copies of a page count too.
 */
let inFlight = 0
const waiting: Array<() => void> = []
async function governed<T>(task: () => Promise<T>): Promise<T> {
  if (inFlight >= IMPORT_MAX_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve))
  else inFlight += 1
  try {
    return await task()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else inFlight -= 1
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

/**
 * The account's profile (see PROFILE_COPIES). A copy that loses is left to
 * finish, as with hedged pages; the profile fails only once every copy sent
 * has failed, and an error that is not about one base (see isFxBaseFailure)
 * sends no more copies, as it would end a single request. That error is also
 * the one reported, over any miss: a throttle's Retry-After is what the caller
 * has to wait, unless a base reports a miss X confirmed. Misses from two
 * different bases settle it at once: the account is gone.
 */
function fetchProfile(handle: string, signal: AbortSignal): Promise<FxAuthor> {
  return new Promise((resolve, reject) => {
    const errors: unknown[] = []
    // Shared by every copy, so the next one asks a base none of them has asked.
    const asked: string[] = []
    let launched = 0
    let pending = 0
    let final = false
    let settled = false
    const launch = () => {
      launched += 1
      pending += 1
      fetchFxProfile(handle, signal, false, asked).then((author) => {
        pending -= 1
        if (settled) return
        settled = true
        resolve(author)
      }, (error: unknown) => {
        pending -= 1
        if (settled) return
        errors.push(error)
        const missing = confirmedProfileMiss(errors)
        if (missing) {
          settled = true
          return reject(missing)
        }
        if (!isFxBaseFailure(error) || signal.aborted) final = true
        if (!final && pending === 0 && launched < PROFILE_ATTEMPTS) return launch()
        if (pending > 0) return
        settled = true
        reject(errors.find(isFxAccountMissing) ?? errors.find((error) => !isFxProfileMiss(error)) ?? errors[0])
      })
    }
    for (let i = 0; i < PROFILE_COPIES; i += 1) launch()
  })
}

export async function importProfilePosts(input: ImportInput): Promise<ImportResult> {
  return withImportSlot(() => walkProfilePosts(input))
}

async function walkProfilePosts(input: ImportInput): Promise<ImportResult> {
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
  input.signal?.throwIfAborted()

  const targetPosts = input.tuning?.windowTargetPosts ?? WINDOW_TARGET_POSTS
  const windowFor = (rate: number) => Math.min(Math.max(targetPosts / rate, WINDOW_MIN_HOURS), WINDOW_MAX_HOURS) * 3_600_000
  const hedge = input.tuning?.hedge ?? (maxPosts <= HEDGED_WALK_MAX_POSTS || (since !== undefined && until - since <= HEDGED_RANGE_MAX_MS) ? WINDOW_PAGE_HEDGE : 1)
  // One chain failing stops the others instead of leaving them spending upstream capacity.
  const stopAll = new AbortController()
  const signal = input.signal ? AbortSignal.any([input.signal, stopAll.signal]) : stopAll.signal
  // Ends the timeline requests still out once the answer is settled; the profile still completes.
  const stopWalk = new AbortController()
  const timeline: FxProfileStatusesOptions = { withReplies: withReplies || onlyReplies, retries: input.tuning?.pageRetries ?? PAGE_RETRIES, gate: governed, signal: AbortSignal.any([signal, stopWalk.signal]) }
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

  const fetchPage = async (cursor: string, copies: number) => {
    const page = await fetchFxProfileStatuses(handle, cursor, 100, { ...timeline, hedge: copies })
    stats.pages += page.attempts ?? 1
    stats.retried += (page.attempts ?? 1) - 1
    return page
  }

  // The profile only bounds a walk near the account's start and goes in the
  // body, so the walk does not wait for it. Either failing fails the import,
  // with whichever error came first.
  let failure: { error: unknown } | undefined
  const fail = (error: unknown) => {
    failure ??= { error }
    stopAll.abort(error)
  }
  let profile: FxAuthor | undefined
  const profileTask = fetchProfile(handle, signal).then((value) => { profile = value }, fail)

  // First page from the range top: sizes the windows and covers the newest slice.
  let first: Awaited<ReturnType<typeof fetchPage>>
  try {
    first = await fetchPage(cursorAt(until + 1), FIRST_PAGE_HEDGE)
  } catch (error) {
    fail(error)
    throw failure!.error
  }
  const rate = estimateRate(first.results, handle)
  let windowMs = windowFor(rate)
  // Own entries per ms of timeline the first page spanned, when it was full and
  // moved: a better guide than `created_at` to how much a window holds, since an
  // old thread root under its reply makes the posting rate look tiny.
  const firstBottom = first.results.length >= FX_SHORT_PAGE && first.cursor?.bottom ? decodeTimelineCursor(first.cursor.bottom) : undefined
  const firstSpan = firstBottom ? until - snowflakeTime(firstBottom.sortIndex) : 0
  const density = firstSpan > 0 ? first.results.filter((post) => ownPost(post, handle)).length / firstSpan : undefined

  // Lazy window generator plus a stack of subdivisions from over-long windows.
  let nextIndex = 0
  let nextStart = until
  const extra: Window[] = []
  let newestNonEmpty = -1
  let emptyBeyond = 0
  let sinceReached = false
  let floorReached = false
  let pageMissing = false
  /** Discovery stopped because `maxPosts` was already collected: older history probably exists. */
  let cappedOut = false
  /** Where the walk had got to when it stopped with chains still out (see `settle`). */
  let coveredTo = -Infinity
  // Nothing predates the account, and no account has more windows than this;
  // both bound a `since`-less walk even if upstream never answers empty. Until
  // the profile arrives only `since` is known; a window claimed past the join
  // date in that gap comes back empty and ends at the floor like any other.
  const joined = () => Date.parse(profile?.joined ?? '')
  const lowerBound = () => Math.max(since ?? 0, Number.isFinite(joined()) ? joined() : 0)
  const claim = (): Window | undefined => {
    const split = extra.pop()
    if (split) return split
    if (sinceReached || floorReached || nextIndex >= MAX_WINDOWS) return undefined
    if (seen.size >= maxPosts) {
      cappedOut = true
      return undefined
    }
    const bound = lowerBound()
    const start = nextStart
    let end = start - windowMs
    if (end <= bound) {
      end = bound
      sinceReached = true
    }
    if (start <= bound) return undefined
    nextStart = end
    return { start, end, index: nextIndex++, head: snowflakeAt(start + 1), oldestSeen: start }
  }

  // Chains in flight; `closed` is set once the walk is over, so a chain finishing late adds nothing.
  const running = new Set<Window>()
  let closed = false
  // Every entry of a page sits below the instant the page was asked from, and
  // its ids are no newer than its position (a repost carries an older
  // original's, a conversation its older parents'). So once `maxPosts` posts
  // are newer than every page still to be asked, the newest `maxPosts` by id
  // are final: nothing left to walk could change them.
  const heldAbove = (floor: bigint) => {
    let count = 0
    for (const id of seen.keys()) if (BigInt(id) >= floor) count += 1
    return count
  }
  // The newest position a page the pool could still ask starts from. With
  // `maxPosts` held it claims no new window, so that is a chain in flight or a
  // split: its next page starts at its head, and a retry after a miss or a
  // split restarts at its oldest seen post.
  const reach = (window: Window) => {
    const restart = snowflakeAt(window.oldestSeen + 1)
    return window.head > restart ? window.head : restart
  }
  const settle = () => {
    if (closed || failure) return
    let floor = 0n
    for (const window of [...running, ...extra]) if (reach(window) > floor) floor = reach(window)
    if (floor === 0n || heldAbove(floor) < maxPosts) return
    closed = true
    cappedOut = true
    for (const window of [...running, ...extra]) coveredTo = Math.max(coveredTo, snowflakeTime(window.head))
    stopWalk.abort(UPSTREAM_CANCELLED)
  }
  // Copies of a page: `hedge` while it may hold part of the newest `maxPosts`,
  // as projected from the posts held above it and those the newer chains in
  // flight should still bring; one past that. Copies never change which pages
  // are asked, only how soon one comes back.
  const expected = (window: Window) => Math.max(0, snowflakeTime(window.head) - window.end) * (density ?? targetPosts / windowMs)
  const copies = (window: Window) => {
    if (hedge <= 1) return 1
    let ahead = heldAbove(window.head)
    for (const other of running) if (other !== window && other.start > window.start) ahead += expected(other)
    return ahead < maxPosts + targetPosts ? hedge : 1
  }

  const walk = async (window: Window): Promise<void> => {
    stats.windows += 1
    // A forged cursor starts strictly below its instant, so seek 1 ms past the bound to include it.
    let cursor = cursorAt(window.start + 1)
    const cursors = new Set<string>()
    let own = 0
    // Upstream answered with nothing at all. A seek into a quiet stretch still
    // returns the entries below it; only a seek past the floor returns none.
    let barren = false
    let resumedAfterMiss = false
    for (let pages = 0; ; pages += 1) {
      let page: Awaited<ReturnType<typeof fetchPage>>
      try {
        if (cursors.has(cursor)) { pageMissing = true; break }
        cursors.add(cursor)
        page = window.index === 0 && window.start === until && pages === 0 ? first : await fetchPage(cursor, copies(window))
      } catch (error) {
        // The walk ended without this page; see `settle`.
        if (closed) return
        if (!(error instanceof ConvertError && error.code === 'partial_upstream_failure')) throw error
        pageMissing = true
        // A forged seek can continue below the last known timeline position.
        // If the miss recurs, other windows can still finish this partial walk.
        if (pages > 0 && !resumedAfterMiss && window.oldestSeen < window.start) {
          resumedAfterMiss = true
          cursor = cursorAt(window.oldestSeen)
          window.head = snowflakeAt(window.oldestSeen)
          continue
        }
        break
      }
      if (closed) return
      if (page.results.length === 0) {
        barren = pages === 0
        break
      }
      // Activity can fall sharply in older history. Resize future windows
      // from observed pages instead of retaining a bursty first-page rate.
      windowMs = Math.max(windowMs, windowFor(estimateRate(page.results, handle)))
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
      if (position !== undefined) window.oldestSeen = Math.min(window.oldestSeen, position)
      const crossed = position !== undefined && position < window.end
      // Skip quiet intervals already covered by this page's tail.
      if (crossed && position !== undefined) nextStart = Math.min(nextStart, position)
      if (crossed || !page.cursor?.bottom) break
      if (pages + 1 >= WINDOW_MAX_PAGES) {
        // Rate was underestimated for this stretch; hand the rest to another chain,
        // but only when this one moved: a window that yielded no own original post
        // would otherwise be re-queued unchanged forever.
        if (window.oldestSeen < window.start && window.oldestSeen > window.end) extra.push({ start: window.oldestSeen, end: window.end, index: window.index, head: snowflakeAt(window.oldestSeen + 1), oldestSeen: window.oldestSeen })
        else pageMissing = true
        break
      }
      cursor = page.cursor.bottom
      // A cursor that does not decode could start anywhere below this window's top.
      window.head = decodeTimelineCursor(cursor)?.sortIndex ?? snowflakeAt(window.start + 1)
      settle()
      if (closed) return
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

  // Each chain claims its next window as soon as it is free, from whatever
  // pages are back by then, so where windows fall depends on which chains
  // finish first; the early stop changes none of it, it only ends the walk.
  const worker = async (): Promise<void> => {
    for (;;) {
      const window = closed ? undefined : claim()
      if (!window || stopAll.signal.aborted) return
      running.add(window)
      try {
        await walk(window)
      } finally {
        running.delete(window)
      }
      settle()
    }
  }
  const workers = Array.from({ length: concurrency }, worker)
  try {
    await Promise.all(workers)
  } catch (error) {
    fail(error)
    await Promise.allSettled(workers)
    throw failure!.error
  }
  await profileTask
  if (failure) throw failure.error

  // Newest first. Reposts sort by the original post's id, which is all upstream gives.
  let posts = [...seen.values()].sort((a, b) => (BigInt(b.id ?? 0) > BigInt(a.id ?? 0) ? 1 : -1))
  const budgetReached = nextIndex >= MAX_WINDOWS && !sinceReached && !floorReached
  const truncated = posts.length > maxPosts || cappedOut || pageMissing || budgetReached
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
      covered_since: iso(Math.max(lowerBound(), nextStart, coveredTo)),
      next_until: truncated ? iso(Math.max(lowerBound(), nextStart, coveredTo, originals.length ? postTime(originals[originals.length - 1]) : until)) : undefined,
      floor_reached: (floorReached || (sinceReached && (since === undefined || since < joined()))) && !pageMissing && !budgetReached && coveredTo === -Infinity,
      warnings: pageMissing || budgetReached ? ['page_missing'] : undefined,
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
