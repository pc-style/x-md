/**
 * Per-account post archive, so history collected once is reused.
 *
 * Every bulk import stores what it walked, keyed by handle; the next import of
 * that account reads the archive and only walks the gaps: newer than the
 * archive's newest post (top-up) and older than its oldest (backfill). The
 * archive always holds the full "with replies" timeline (own posts, replies and
 * reposts); the caller's filters are applied when serving from it.
 *
 * Store: the shared Upstash/Vercel KV Redis (lib/redis.ts) when configured, an
 * in-process map otherwise. Per handle:
 *   hist:{handle}:index  hash   count, oldest, newest, updated_at, floor_reached
 *   hist:{handle}:ids    zset   member = post id, score = post time in ms
 *   hist:{handle}:posts  hash   post id -> JSON
 * Reads are bounded to the posts a response can use (a 3,500-post archive is
 * ~10 MB of JSON, half a second to move), and a write is one parallel round
 * of pipelined chunks; X costs seconds per page.
 *
 * Engagement counts in archived posts are as of the walk that stored them.
 * `refresh: true` re-walks the requested range and overwrites.
 */
import { withHistoryLock } from './import-admission.js'
import { ConvertError } from './errors.js'
import { redisConfig, redisPipeline, type RedisCommand } from './redis.js'
import { importProfilePosts, isRepost, isReply, ownPost, postTime, type ImportInput, type ImportMeta, type ImportResult } from './import.js'
import type { FxAuthor, FxTweet } from './fxtwitter.js'

export interface HistoryIndex {
  handle: string
  count: number
  /** ISO 8601 of the oldest and newest non-repost post held. */
  oldest?: string
  newest?: string
  updated_at: string
  /** The archive reaches X's timeline floor: there is nothing older to fetch. */
  floor_reached: boolean
  /** The time range walks have covered so far (ISO 8601); gaps are computed against this, not against post dates. */
  covered_since?: string
  covered_until?: string
  /** A missing upstream page left a gap that the next request must re-walk. */
  incomplete?: boolean
  coverage_version?: number
}

export interface HistoryMeta extends ImportMeta {
  archive: HistoryIndex & {
    /** Posts in this response that came from the archive rather than a fresh walk. */
    served: number
    /** Posts this request fetched upstream and added. */
    added: number
    /** Gaps that were walked: `top-up` (newer than the archive), `backfill` (older), `refresh` (the whole range). */
    walked: Array<'top-up' | 'backfill' | 'refresh'>
  }
}

export interface HistoryResult extends Omit<ImportResult, 'meta'> {
  meta: HistoryMeta
}

/** Gap walks overlap the archive edge by this much: X orders pages by conversation, not time. */
const EDGE_OVERLAP_MS = 6 * 3_600_000
/** A top-up is skipped when the archive was refreshed this recently. */
const FRESH_MS = 60_000
/** Posts per Redis pipeline call, under Upstash's request size limit. */
const WRITE_CHUNK = 150
/** Write chunks in flight at once. */
const WRITE_PARALLEL = 6
/** Smallest archive read when filters may discard posts, so a filtered request does not crawl. */
const READ_CHUNK = 200

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** An archived post with the score the store sorts it by; `post` is missing if its body is. */
interface Entry { id: string; score: number; post?: FxTweet }

/** The store's order: score descending, ties by id descending as Redis compares members (bytewise). */
const storeOrder = (a: Entry, b: Entry) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)

interface Store {
  readIndex(handle: string): Promise<HistoryIndex | undefined>
  writeIndex(index: HistoryIndex): Promise<void>
  /** Scores each post by postTime; resolves with the number of posts archived for the handle afterwards. */
  put(handle: string, posts: FxTweet[]): Promise<number>
  /** Entries scored in [from, to] in store order; `page` skips `offset` of them and returns at most `count`. */
  range(handle: string, from: number, to: number, page?: { offset: number; count: number }): Promise<Entry[]>
  stats(handle: string): Promise<{ count: number }>
  clear(handle: string): Promise<void>
}

const memory = new Map<string, { index?: HistoryIndex; posts: Map<string, FxTweet> }>()
function bucket(handle: string) {
  const key = handle.toLowerCase()
  let entry = memory.get(key)
  if (!entry) memory.set(key, (entry = { posts: new Map() }))
  return entry
}

const memoryStore: Store = {
  async readIndex(handle) { return bucket(handle).index },
  async writeIndex(index) { bucket(index.handle).index = index },
  async put(handle, posts) { const b = bucket(handle); for (const post of posts) if (post.id) b.posts.set(post.id, post); return b.posts.size },
  async range(handle, from, to, page) {
    const all = [...bucket(handle).posts.values()].map((post): Entry => ({ id: post.id!, score: postTime(post), post })).filter((entry) => entry.score >= from && entry.score <= to).sort(storeOrder)
    return page ? all.slice(page.offset, page.offset + page.count) : all
  },
  async stats(handle) { return { count: bucket(handle).posts.size } },
  async clear(handle) { memory.delete(handle.toLowerCase()) },
}

function keys(handle: string) {
  const h = handle.toLowerCase()
  return { index: `hist:${h}:index`, ids: `hist:${h}:ids`, posts: `hist:${h}:posts` }
}

function redisStore(config: NonNullable<ReturnType<typeof redisConfig>>): Store {
  const run = <T = unknown>(commands: RedisCommand[], timeoutMs = 5000) => redisPipeline<T>(config, commands, timeoutMs)
  return {
    async readIndex(handle) {
      const [reply] = await run<string[]>([['HGETALL', keys(handle).index]])
      const flat = reply.result ?? []
      if (!flat.length) return undefined
      const map: Record<string, string> = {}
      for (let i = 0; i < flat.length; i += 2) map[flat[i]] = flat[i + 1]
      return { handle: map.handle ?? handle, count: Number(map.count ?? 0), oldest: map.oldest || undefined, newest: map.newest || undefined, updated_at: map.updated_at ?? new Date(0).toISOString(), floor_reached: map.floor_reached === '1', covered_since: map.covered_since || undefined, covered_until: map.covered_until || undefined, incomplete: map.incomplete === '1', coverage_version: Number(map.coverage_version ?? 0) }
    },
    async writeIndex(index) {
      const k = keys(index.handle).index
      await run([['HSET', k, 'handle', index.handle, 'count', index.count, 'oldest', index.oldest ?? '', 'newest', index.newest ?? '', 'updated_at', index.updated_at, 'floor_reached', index.floor_reached ? '1' : '0', 'covered_since', index.covered_since ?? '', 'covered_until', index.covered_until ?? '', 'incomplete', index.incomplete ? '1' : '0', 'coverage_version', 2]])
    },
    async put(handle, posts) {
      const k = keys(handle)
      const chunks: RedisCommand[][] = []
      for (let i = 0; i < posts.length; i += WRITE_CHUNK) {
        const chunk = posts.slice(i, i + WRITE_CHUNK).filter((post) => post.id)
        if (!chunk.length) continue
        const zadd: RedisCommand = ['ZADD', k.ids]
        const hset: RedisCommand = ['HSET', k.posts]
        for (const post of chunk) {
          zadd.push(postTime(post), post.id!)
          hset.push(post.id!, JSON.stringify(post))
        }
        chunks.push([zadd, hset, ['ZCARD', k.ids]])
      }
      if (!chunks.length) {
        const [count] = await run<number>([['ZCARD', k.ids]])
        return Number(count.result ?? 0)
      }
      // Chunks only add members and each counts after its own ZADD, so the
      // largest count is the one taken after every chunk had landed. A failed
      // chunk fails the write only once its siblings have landed too: the
      // caller holds this handle's lock until `put` settles, and a write still
      // in flight after that could overwrite the next holder's newer copy.
      let count = 0
      for (let i = 0; i < chunks.length; i += WRITE_PARALLEL) {
        const replies = await Promise.allSettled(chunks.slice(i, i + WRITE_PARALLEL).map((commands) => run<number>(commands, 10_000)))
        for (const reply of replies) {
          if (reply.status === 'rejected') throw reply.reason
          count = Math.max(count, Number(reply.value[2]?.result ?? 0))
        }
      }
      return count
    },
    async range(handle, from, to, page) {
      const k = keys(handle)
      const [scored] = await run<string[]>([['ZRANGE', k.ids, to, from, 'BYSCORE', 'REV', ...(page ? ['LIMIT', page.offset, page.count] : []), 'WITHSCORES']])
      const flat = scored.result ?? []
      const entries: Entry[] = []
      for (let i = 0; i < flat.length; i += 2) entries.push({ id: flat[i], score: Number(flat[i + 1]) })
      if (!entries.length) return []
      // One pipeline round-trip for every chunk of bodies.
      const chunks: RedisCommand[] = []
      for (let i = 0; i < entries.length; i += 500) chunks.push(['HMGET', k.posts, ...entries.slice(i, i + 500).map((entry) => entry.id)])
      const replies = await run<(string | null)[]>(chunks, 15_000)
      replies.forEach((reply, chunk) => (reply.result ?? []).forEach((raw, i) => {
        if (raw) entries[chunk * 500 + i].post = JSON.parse(raw) as FxTweet
      }))
      return entries
    },
    async stats(handle) {
      const [count] = await run<number>([['ZCARD', keys(handle).ids]])
      return { count: Number(count.result ?? 0) }
    },
    async clear(handle) { const k = keys(handle); await run([['DEL', k.index, k.ids, k.posts]]) },
  }
}

let override: Store | undefined
function store(): Store {
  if (override) return override
  const config = redisConfig()
  return config ? redisStore(config) : memoryStore
}

/** Test hook: swap the store (pass `undefined` to restore) and clear memory. */
export function resetHistoryStore(replacement?: Store): void {
  override = replacement
  memory.clear()
}

export function historyPersistent(): boolean {
  return redisConfig() !== undefined
}

/** Read an account's archive index without walking anything. */
export async function readHistoryIndex(handle: string): Promise<HistoryIndex | undefined> {
  return store().readIndex(handle)
}

// ---------------------------------------------------------------------------
// Import through the archive
// ---------------------------------------------------------------------------

export interface HistoryInput extends Omit<ImportInput, 'withReplies' | 'withReposts' | 'onlyReplies'> {
  withReplies?: boolean
  withReposts?: boolean
  onlyReplies?: boolean
  /** Re-walk the whole requested range and overwrite archived posts in it. */
  refresh?: boolean
}

interface Coverage { since?: number; until: number; floor: boolean }

/**
 * Write the index for posts already stored (`count` is the archive size that
 * `put` reported). `previous` is the index as read under this handle's lock,
 * so it is still current.
 */
async function record(s: Store, handle: string, posts: FxTweet[], count: number | undefined, covered: Coverage[], incomplete: boolean, previous: HistoryIndex | undefined): Promise<HistoryIndex> {
  if (!posts.length && !covered.length && previous && !incomplete) return previous
  const stats = { count: count ?? (await s.stats(handle)).count }
  // Oldest/newest come from the posts this request added (reposts excluded:
  // they carry the original's date) merged with what the index already said.
  const times = posts.filter((post) => !isRepost(post)).map(postTime).filter(Boolean)
  const oldestMs = Math.min(...times, previous?.oldest ? Date.parse(previous.oldest) : Infinity)
  const newestMs = Math.max(...times, previous?.newest ? Date.parse(previous.newest) : -Infinity)
  // Only advertise a contiguous covered range. A capped top-up or a refresh
  // can be disjoint from the old archive; retaining its old lower bound would
  // hide the unfetched gap forever. Keep the newest interval conservatively.
  const intervals = [...covered]
  if (previous?.covered_until && previous.coverage_version === 2 && !previous.incomplete) intervals.push({
    since: previous.floor_reached ? undefined : previous.covered_since ? Date.parse(previous.covered_since) : previous.oldest ? Date.parse(previous.oldest) : Date.parse(previous.covered_until),
    until: Date.parse(previous.covered_until), floor: previous.floor_reached,
  })
  intervals.sort((a, b) => b.until - a.until)
  let coverage = intervals[0]
  for (const interval of intervals.slice(1)) {
    if (interval.until < (coverage.since ?? -Infinity)) break
    coverage = { since: coverage.since === undefined || interval.since === undefined ? undefined : Math.min(coverage.since, interval.since), until: coverage.until, floor: coverage.floor || interval.floor }
  }
  const floor = coverage?.floor ?? false
  const coveredSince = coverage?.since
  const coveredUntil = coverage?.until
  const index: HistoryIndex = {
    handle,
    count: stats.count,
    oldest: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : undefined,
    newest: Number.isFinite(newestMs) ? new Date(newestMs).toISOString() : undefined,
    updated_at: new Date().toISOString(),
    floor_reached: floor,
    incomplete,
    coverage_version: 2,
    covered_since: coveredSince === undefined ? undefined : new Date(coveredSince).toISOString(),
    covered_until: coveredUntil ? new Date(coveredUntil).toISOString() : previous?.incomplete ? undefined : previous?.covered_until,
  }
  await s.writeIndex(index)
  return index
}

/** Wait for every task, then fail with the first failure: a failed read must not leave a walk running unwatched. */
async function settleAll(tasks: Array<Promise<unknown> | undefined>): Promise<void> {
  for (const result of await Promise.allSettled(tasks)) if (result.status === 'rejected') throw result.reason
}

/**
 * Newest-first posts in [from, to] that pass `wanted`, at most `need` of them,
 * read in pages so a large archive is not pulled whole for a short answer.
 */
async function readWanted(s: Store, handle: string, from: number, to: number, wanted: (post: FxTweet) => boolean, need: number, unfiltered: boolean): Promise<Entry[]> {
  const out: Entry[] = []
  const count = unfiltered ? need : Math.max(need * 2, READ_CHUNK)
  for (let offset = 0; ; offset += count) {
    const page = await s.range(handle, from, to, { offset, count })
    for (const entry of page) if (entry.post && wanted(entry.post)) out.push(entry)
    if (out.length >= need || page.length < count) return out.slice(0, need)
  }
}

export async function importWithHistory(input: HistoryInput): Promise<HistoryResult> {
  return withHistoryLock(input.handle, () => importHistory(input))
}

async function importHistory(input: HistoryInput): Promise<HistoryResult> {
  const s = store()
  const startedAt = Date.now()
  const handle = input.handle
  const until = input.until?.getTime() ?? Date.now()
  const since = input.since?.getTime()
  if (since !== undefined && since >= until) throw new ConvertError(400, '`since` must be earlier than `until`.', 'invalid_option')
  const maxPosts = input.maxPosts ?? 500
  let capped = false
  const withReplies = input.withReplies ?? true
  const withReposts = input.withReposts ?? true
  const onlyReplies = input.onlyReplies ?? false
  const wanted = (post: FxTweet): boolean => {
    if (!ownPost(post, handle)) return false
    if (isRepost(post)) return withReposts && !onlyReplies
    if (onlyReplies) return isReply(post)
    if (!withReplies && isReply(post)) return false
    return true
  }

  const emitted = new Set<string>()
  const emit = (post: FxTweet) => {
    if (!post.id || emitted.has(post.id) || !wanted(post)) return
    emitted.add(post.id)
    // Stream only the final selection: concurrent arrivals can be evicted by newer posts.
  }

  // The lock holds every other writer off this handle, so this read stays current for `record`.
  const previous = await s.readIndex(handle)
  let index = input.refresh ? undefined : previous
  const walked: HistoryMeta['archive']['walked'] = []
  let profile: FxAuthor | undefined
  let added = 0
  const walks: Array<Pick<ImportMeta, 'windows' | 'pages' | 'retried_pages' | 'estimated_rate_per_hour' | 'concurrency'>> = []
  const fresh: FxTweet[] = []
  const warnings: NonNullable<ImportMeta['warnings']> = []
  const covered: Coverage[] = []
  const walk = async (kind: HistoryMeta['archive']['walked'][number], from: number | undefined, to: number, maxPosts: number) => {
    walked.push(kind)
    const result = await importProfilePosts({
      handle, since: from === undefined ? undefined : new Date(from), until: new Date(to), maxPosts: !withReplies || !withReposts || onlyReplies ? 5000 : maxPosts,
      concurrency: input.concurrency, withReplies: true, withReposts: true, signal: input.signal, tuning: input.tuning,
      onPost: (post) => { if (postTime(post) <= until && (since === undefined || postTime(post) >= since || isRepost(post))) emit(post) },
    })
    fresh.push(...result.posts)
    capped ||= result.meta.truncated
    if (result.meta.warnings) warnings.push(...result.meta.warnings)
    profile ??= result.profile
    walks.push(result.meta)
    // A capped walk did not reach `from`; what it covered ends at its oldest post.
    const reachedFrom = !result.meta.truncated
    if (!result.meta.warnings?.length) covered.push({ since: reachedFrom && result.meta.floor_reached ? undefined : reachedFrom ? from : (result.meta.next_until ? Date.parse(result.meta.next_until) : result.meta.oldest ? Date.parse(result.meta.oldest) : to), until: to, floor: reachedFrom && result.meta.floor_reached })
    return result
  }

  // Only the newest `maxPosts` (plus one, to tell a full answer from a
  // truncated one) can reach the body, and a gap walk only needs to know
  // whether the archive already holds that many. The read runs alongside the
  // first walk; together with the walked posts it is the final body.
  const unfiltered = withReplies && withReposts && !onlyReplies
  const archived = readWanted(s, handle, since ?? 0, until, wanted, maxPosts + 1, unfiltered)

  if (!index || index.incomplete || index.coverage_version !== 2) {
    await settleAll([walk('refresh', since, until, maxPosts), archived])
  } else {
    const coveredUntil = index.covered_until ? Date.parse(index.covered_until) : (index.newest ? Date.parse(index.newest) : undefined)
    const coveredSince = index.floor_reached ? undefined : index.covered_since ? Date.parse(index.covered_since) : (index.oldest ? Date.parse(index.oldest) : undefined)
    const refreshedAt = Date.parse(index.updated_at)
    // Skip the top-up when the archive was refreshed moments ago and the request
    // reaches no further than moments past that refresh.
    const freshEnough = Date.now() - refreshedAt < FRESH_MS && until - refreshedAt < FRESH_MS
    // The archive read and the top-up are independent; only the backfill decision needs both.
    await settleAll([
      archived.then((entries) => { for (const entry of entries) emit(entry.post!) }),
      coveredUntil === undefined || (until > coveredUntil && !freshEnough)
        ? walk('top-up', coveredUntil === undefined ? since : Math.max(since ?? 0, coveredUntil - EDGE_OVERLAP_MS), until, maxPosts)
        : undefined,
    ])
    const needOlder = !index.floor_reached && (since === undefined || coveredSince === undefined || since < coveredSince)
    if (needOlder && emitted.size < maxPosts) {
      await walk('backfill', since, coveredSince === undefined ? until : coveredSince + EDGE_OVERLAP_MS, maxPosts)
    } else if (needOlder) {
      // The archive alone filled the cap, so the older part of the range was
      // never walked: the caller has to know there is more than it got.
      capped = true
    }
  }
  // Walks overlap at their edges; the last copy of a post is the one stored.
  const stored = new Map<string, FxTweet>()
  for (const post of fresh) if (post.id) stored.set(post.id, post)
  const count = stored.size ? await s.put(handle, [...stored.values()]) : undefined
  index = await record(s, handle, fresh, count, covered, warnings.length > 0, previous)
  added = fresh.length

  // Final body, filtered and capped, newest first: what a read of the archive
  // would now return. The lock kept every other writer out, so that is the
  // first read with the posts just stored laid over it, in store order.
  const read = await archived
  const last = read.at(-1)
  const selection = new Map(read.map((entry) => [entry.id, entry]))
  // A stored post that leaves the read's span (filtered out, or rescored below
  // its last entry) frees a place that only an unread post could take.
  let vacated = false
  for (const [id, post] of stored) {
    const entry = { id, score: postTime(post), post }
    const inRange = entry.score >= (since ?? 0) && entry.score <= until && wanted(post)
    if (selection.has(id) && (!inRange || (last && storeOrder(entry, last) > 0))) vacated = true
    if (inRange) selection.set(id, entry)
    else selection.delete(id)
  }
  const selected = vacated && read.length > maxPosts ? await readWanted(s, handle, since ?? 0, until, wanted, maxPosts + 1, unfiltered) : [...selection.values()].sort(storeOrder)
  let posts = selected.slice(0, maxPosts + 1).map((entry) => entry.post!)
  const truncated = posts.length > maxPosts || capped
  if (truncated) posts = posts.slice(0, maxPosts)
  const originals = posts.filter((post) => !isRepost(post))
  const freshIds = new Set(fresh.map((post) => post.id))
  const sum = (key: 'windows' | 'pages' | 'retried_pages') => walks.reduce((a, w) => a + (w[key] ?? 0), 0)
  const meta: HistoryMeta = {
    handle,
    count: posts.length,
    since: since === undefined ? undefined : new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    oldest: originals.length ? new Date(postTime(originals[originals.length - 1])).toISOString() : undefined,
    newest: originals.length ? new Date(postTime(originals[0])).toISOString() : undefined,
    truncated,
    floor_reached: warnings.length ? false : index.floor_reached,
    covered_since: index.covered_since,
    next_until: truncated && originals.length ? new Date(Math.max(postTime(originals[originals.length - 1]), index.covered_since ? Date.parse(index.covered_since) : 0)).toISOString() : undefined,
    warnings: warnings.length ? [...new Set(warnings)] : undefined,
    with_replies: withReplies,
    with_reposts: withReposts,
    only_replies: onlyReplies,
    concurrency: walks[0]?.concurrency ?? input.concurrency ?? 0,
    windows: sum('windows'),
    pages: sum('pages'),
    retried_pages: sum('retried_pages'),
    duration_ms: Date.now() - startedAt,
    estimated_rate_per_hour: walks[0]?.estimated_rate_per_hour ?? 0,
    source: 'fxtwitter',
    archive: { ...index, served: posts.filter((post) => !freshIds.has(post.id)).length, added, walked },
  }
  for (const post of posts) input.onPost?.(post)
  return { profile, posts, meta }
}
