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
 * The store is never the bottleneck: a 2000-post write is a few pipelined
 * commands; X costs seconds per page.
 *
 * Engagement counts in archived posts are as of the walk that stored them.
 * `refresh: true` re-walks the requested range and overwrites.
 */
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface Store {
  readIndex(handle: string): Promise<HistoryIndex | undefined>
  writeIndex(index: HistoryIndex): Promise<void>
  put(handle: string, posts: FxTweet[]): Promise<void>
  /** Posts with time in [from, to], newest first. */
  range(handle: string, from: number, to: number): Promise<FxTweet[]>
  stats(handle: string): Promise<{ count: number; oldest?: number; newest?: number }>
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
  async put(handle, posts) { const b = bucket(handle); for (const post of posts) if (post.id) b.posts.set(post.id, post) },
  async range(handle, from, to) {
    return [...bucket(handle).posts.values()].filter((post) => { const at = postTime(post); return at >= from && at <= to }).sort((a, b) => postTime(b) - postTime(a) || (BigInt(b.id ?? 0) > BigInt(a.id ?? 0) ? 1 : -1))
  },
  async stats(handle) {
    const times = [...bucket(handle).posts.values()].filter((post) => !isRepost(post)).map(postTime)
    return { count: bucket(handle).posts.size, oldest: times.length ? Math.min(...times) : undefined, newest: times.length ? Math.max(...times) : undefined }
  },
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
      return { handle: map.handle ?? handle, count: Number(map.count ?? 0), oldest: map.oldest || undefined, newest: map.newest || undefined, updated_at: map.updated_at ?? new Date(0).toISOString(), floor_reached: map.floor_reached === '1', covered_since: map.covered_since || undefined, covered_until: map.covered_until || undefined }
    },
    async writeIndex(index) {
      const k = keys(index.handle).index
      await run([['HSET', k, 'handle', index.handle, 'count', index.count, 'oldest', index.oldest ?? '', 'newest', index.newest ?? '', 'updated_at', index.updated_at, 'floor_reached', index.floor_reached ? '1' : '0', 'covered_since', index.covered_since ?? '', 'covered_until', index.covered_until ?? '']])
    },
    async put(handle, posts) {
      const k = keys(handle)
      for (let i = 0; i < posts.length; i += WRITE_CHUNK) {
        const chunk = posts.slice(i, i + WRITE_CHUNK).filter((post) => post.id)
        if (!chunk.length) continue
        const zadd: RedisCommand = ['ZADD', k.ids]
        const hset: RedisCommand = ['HSET', k.posts]
        for (const post of chunk) {
          zadd.push(postTime(post), post.id!)
          hset.push(post.id!, JSON.stringify(post))
        }
        await run([zadd, hset], 10_000)
      }
    },
    async range(handle, from, to) {
      const k = keys(handle)
      const [ids] = await run<string[]>([['ZRANGE', k.ids, to, from, 'BYSCORE', 'REV']])
      const list = ids.result ?? []
      if (!list.length) return []
      // One pipeline round-trip for every chunk of bodies.
      const chunks: RedisCommand[] = []
      for (let i = 0; i < list.length; i += 500) chunks.push(['HMGET', k.posts, ...list.slice(i, i + 500)])
      const replies = await run<(string | null)[]>(chunks, 15_000)
      const out: FxTweet[] = []
      for (const reply of replies) for (const raw of reply.result ?? []) if (raw) out.push(JSON.parse(raw) as FxTweet)
      return out
    },
    async stats(handle) {
      const k = keys(handle)
      const [count, newest, oldest] = await run<unknown>([['ZCARD', k.ids], ['ZRANGE', k.ids, '+inf', '-inf', 'BYSCORE', 'REV', 'LIMIT', 0, 1, 'WITHSCORES'], ['ZRANGE', k.ids, '-inf', '+inf', 'BYSCORE', 'LIMIT', 0, 1, 'WITHSCORES']])
      const score = (reply: { result?: unknown }) => { const r = reply.result as (string | number)[] | undefined; return r && r.length >= 2 ? Number(r[1]) : undefined }
      return { count: Number(count.result ?? 0), newest: score(newest), oldest: score(oldest) }
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

async function record(s: Store, handle: string, posts: FxTweet[], covered: Coverage[]): Promise<HistoryIndex> {
  if (posts.length) await s.put(handle, posts)
  const previous = await s.readIndex(handle)
  const stats = await s.stats(handle)
  // Coverage grows monotonically: the walks in this request plus what was covered before.
  const sinceValues = covered.map((c) => c.since)
  const prevSince = previous?.covered_since ? Date.parse(previous.covered_since) : undefined
  const floor = covered.some((c) => c.floor) || (previous?.floor_reached ?? false)
  const coveredSince = floor || sinceValues.includes(undefined) ? undefined : Math.min(...(sinceValues as number[]), ...(prevSince !== undefined ? [prevSince] : []))
  const coveredUntil = Math.max(...covered.map((c) => c.until), previous?.covered_until ? Date.parse(previous.covered_until) : 0)
  const index: HistoryIndex = {
    handle,
    count: stats.count,
    oldest: stats.oldest !== undefined ? new Date(stats.oldest).toISOString() : previous?.oldest,
    newest: stats.newest !== undefined ? new Date(stats.newest).toISOString() : previous?.newest,
    updated_at: new Date().toISOString(),
    floor_reached: floor,
    covered_since: coveredSince === undefined ? undefined : new Date(coveredSince).toISOString(),
    covered_until: coveredUntil ? new Date(coveredUntil).toISOString() : previous?.covered_until,
  }
  await s.writeIndex(index)
  return index
}

export async function importWithHistory(input: HistoryInput): Promise<HistoryResult> {
  const s = store()
  const startedAt = Date.now()
  const handle = input.handle
  const until = input.until?.getTime() ?? Date.now()
  const since = input.since?.getTime()
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
    input.onPost?.(post)
  }

  let index = input.refresh ? undefined : await s.readIndex(handle)
  const walked: HistoryMeta['archive']['walked'] = []
  let profile: FxAuthor | undefined
  let added = 0
  const walks: Array<Pick<ImportMeta, 'windows' | 'pages' | 'retried_pages' | 'estimated_rate_per_hour' | 'concurrency'>> = []
  const fresh: FxTweet[] = []
  const covered: Coverage[] = []
  const walk = async (kind: HistoryMeta['archive']['walked'][number], from: number | undefined, to: number, maxPosts: number) => {
    walked.push(kind)
    const result = await importProfilePosts({
      handle, since: from === undefined ? undefined : new Date(from), until: new Date(to), maxPosts,
      concurrency: input.concurrency, withReplies: true, withReposts: true, signal: input.signal, tuning: input.tuning,
      onPost: (post) => { fresh.push(post); if (postTime(post) <= until && (since === undefined || postTime(post) >= since || isRepost(post))) emit(post) },
    })
    profile ??= result.profile
    walks.push(result.meta)
    // A capped walk did not reach `from`; what it covered ends at its oldest post.
    const reachedFrom = !result.meta.truncated
    covered.push({ since: result.meta.floor_reached ? undefined : reachedFrom ? from : (result.meta.oldest ? Date.parse(result.meta.oldest) : to), until: to, floor: result.meta.floor_reached })
    return result
  }

  // Serve the archived part first; it is instant.
  let archived: FxTweet[] | undefined
  if (index) {
    archived = await s.range(handle, since ?? 0, until)
    for (const post of archived) emit(post)
  }

  const maxPosts = input.maxPosts ?? 500
  if (!index) {
    await walk('refresh', since, until, maxPosts)
  } else {
    const coveredUntil = index.covered_until ? Date.parse(index.covered_until) : (index.newest ? Date.parse(index.newest) : undefined)
    const coveredSince = index.floor_reached ? undefined : index.covered_since ? Date.parse(index.covered_since) : (index.oldest ? Date.parse(index.oldest) : undefined)
    const refreshedAt = Date.parse(index.updated_at)
    // Skip the top-up when the archive was refreshed moments ago and the request
    // reaches no further than moments past that refresh.
    const freshEnough = Date.now() - refreshedAt < FRESH_MS && until - refreshedAt < FRESH_MS
    if (coveredUntil === undefined || (until > coveredUntil && !freshEnough)) {
      await walk('top-up', coveredUntil === undefined ? since : Math.max(since ?? 0, coveredUntil - EDGE_OVERLAP_MS), until, maxPosts)
    }
    const needOlder = !index.floor_reached && (since === undefined || coveredSince === undefined || since < coveredSince)
    if (needOlder && emitted.size < maxPosts) {
      await walk('backfill', since, coveredSince === undefined ? until : coveredSince + EDGE_OVERLAP_MS, maxPosts)
    }
  }
  index = await record(s, handle, fresh, covered)
  added = fresh.length

  // Final body from the archive, filtered and capped, newest first. When nothing
  // was walked the first read is still current, so do not read it again.
  let posts = (walked.length === 0 && archived ? archived : await s.range(handle, since ?? 0, until)).filter(wanted)
  const truncated = posts.length > maxPosts
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
    floor_reached: index.floor_reached,
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
  return { profile, posts, meta }
}
