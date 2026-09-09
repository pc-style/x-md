import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./fxtwitter.js', async () => {
  const actual = await vi.importActual<typeof import('./fxtwitter.js')>('./fxtwitter.js')
  return { ...actual, fetchFxProfile: vi.fn(), fetchFxProfileStatuses: vi.fn() }
})

import { decodeTimelineCursor, encodeTimelineCursor, snowflakeAt, snowflakeTime } from './fx-cursor.js'
import { fetchFxProfile, fetchFxProfileStatuses, type FxListResponse, type FxTweet } from './fxtwitter.js'
import { estimateRate, importProfilePosts, isReply, ownPost, postTime } from './import.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 9, 12)
const xdate = (ms: number) => new Date(ms).toUTCString()

interface Entry { sort: bigint; post: FxTweet }

/**
 * A fake X timeline: `count` own posts one every `gapHours`, every 5th a reply,
 * every 7th a repost of a much older post, every 11th a conversation parent by
 * someone else. Entries are sorted by `sort` (timeline position), which for a
 * repost is the repost time, not the original's id.
 */
function timeline(handle: string, count: number, gapHours: number): Entry[] {
  const entries: Entry[] = []
  for (let i = 0; i < count; i += 1) {
    const at = NOW - i * gapHours * HOUR
    const sort = snowflakeAt(at) + BigInt(i % 7)
    if (i % 7 === 3) {
      const originalAt = at - 400 * 24 * HOUR
      const id = (snowflakeAt(originalAt) + 1n).toString()
      entries.push({ sort, post: { id, text: `rt ${i}`, created_at: xdate(originalAt), author: { screen_name: 'someone' }, reposted_by: { screen_name: handle } } })
      continue
    }
    if (i % 11 === 5) {
      entries.push({ sort, post: { id: sort.toString(), text: `parent ${i}`, created_at: xdate(at), author: { screen_name: 'other' } } })
      continue
    }
    const reply = i % 5 === 0
    entries.push({ sort, post: { id: sort.toString(), text: `${reply ? 'reply' : 'post'} ${i}`, created_at: xdate(at), author: { screen_name: handle }, replying_to: reply ? { screen_name: 'other', status: '1' } : null } })
  }
  return entries
}

function fakeUpstream(entries: Entry[], options: { pageSize?: number; flakeEvery?: number; floor?: number } = {}) {
  const pageSize = options.pageSize ?? 30
  let calls = 0
  const served = new Set<string>()
  const mock = async (_handle: string, cursor?: string): Promise<FxListResponse<FxTweet>> => {
    calls += 1
    const decoded = cursor ? decodeTimelineCursor(cursor) : undefined
    if (cursor && !decoded) throw new Error(`bad cursor ${cursor}`)
    const below = decoded?.sortIndex ?? (snowflakeAt(NOW) + 1_000_000n)
    const start = entries.findIndex((entry) => entry.sort < below)
    if (start < 0 || (options.floor !== undefined && start >= options.floor)) return { results: [], attempts: 1 }
    const page = entries.slice(start, Math.min(start + pageSize, options.floor ?? entries.length))
    // The bimodal upstream: every Nth call answers with one item instead of a page.
    if (options.flakeEvery && calls % options.flakeEvery === 0) return { results: page.slice(0, 1), cursor: { bottom: 'flaky' }, attempts: 1 }
    for (const entry of page) served.add(entry.post.id!)
    const last = page[page.length - 1]
    return { results: page.map((entry) => entry.post), cursor: { bottom: encodeTimelineCursor({ issuedAt: 0n, sortIndex: last.sort, direction: 2 }) }, attempts: 1 }
  }
  return { mock, calls: () => calls, served }
}

/** Reproduce the retry loop the real fetchFxProfileStatuses runs around a raw page fetch. */
function withRetries(fetch: (handle: string, cursor?: string) => Promise<FxListResponse<FxTweet>>) {
  return async (handle: string, cursor?: string, _count?: number, options?: { retries?: number }) => {
    let best: FxListResponse<FxTweet> = { results: [] }
    const attempts = 1 + (options?.retries ?? 0)
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const page = await fetch(handle, cursor)
      if (page.results.length >= 8) return { ...page, attempts: attempt + 1 }
      if (page.results.length >= best.results.length) best = page
    }
    return { ...best, attempts }
  }
}

const own = (handle: string, entries: Entry[]) => entries.filter((entry) => ownPost(entry.post, handle))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(fetchFxProfile).mockResolvedValue({ screen_name: 'ada', name: 'Ada', statuses: 5000 })
})

describe('importProfilePosts', () => {
  test('covers a whole range in parallel with no gaps or duplicates', async () => {
    const entries = timeline('ada', 900, 1)
    const upstream = fakeUpstream(entries)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
    const since = new Date(NOW - 600 * HOUR)
    const result = await importProfilePosts({ handle: 'ada', since, until: new Date(NOW), maxPosts: 5000, concurrency: 8 })
    const expected = own('ada', entries).filter((entry) => snowflakeTime(entry.sort) >= since.getTime())
    // Reposts sitting just past the range edge may ride along: only their original's time is known.
    const nonRepost = (posts: { id?: string; reposted_by?: unknown }[]) => posts.filter((post) => !post.reposted_by).map((post) => post.id).sort()
    expect(nonRepost(result.posts)).toEqual(nonRepost(expected.map((entry) => entry.post)))
    expect(result.posts.filter((post) => post.reposted_by).length).toBeGreaterThanOrEqual(expected.filter((entry) => entry.post.reposted_by).length)
    expect(result.posts.every((post) => ownPost(post, 'ada'))).toBe(true)
    expect(result.meta.windows).toBeGreaterThan(4)
    expect(result.meta.truncated).toBe(false)
    expect(result.meta.floor_reached).toBe(false)
    expect(result.meta.oldest).toBe(new Date(since.getTime()).toISOString())
    // Sorted newest first by id.
    const ids = result.posts.map((post) => BigInt(post.id!))
    expect(ids.every((id, index) => index === 0 || ids[index - 1] > id)).toBe(true)
  })

  test('is not fooled by short pages or old reposts', async () => {
    const entries = timeline('ada', 400, 2)
    const upstream = fakeUpstream(entries, { flakeEvery: 3 })
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
    const since = new Date(NOW - 700 * HOUR)
    const result = await importProfilePosts({ handle: 'ada', since, until: new Date(NOW), maxPosts: 5000, concurrency: 4 })
    const expected = own('ada', entries).filter((entry) => snowflakeTime(entry.sort) >= since.getTime())
    expect(result.posts.filter((post) => !post.reposted_by)).toHaveLength(expected.filter((entry) => !entry.post.reposted_by).length)
    expect(result.posts.filter((post) => post.reposted_by).length).toBeGreaterThanOrEqual(expected.filter((entry) => entry.post.reposted_by).length)
    expect(result.meta.retried_pages).toBeGreaterThan(0)
  })

  test('stops at the upstream floor and reports it', async () => {
    const entries = timeline('ada', 2000, 1)
    const upstream = fakeUpstream(entries, { floor: 500 })
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
    const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 5000, concurrency: 8 })
    expect(result.posts).toHaveLength(own('ada', entries.slice(0, 500)).length)
    expect(result.meta.floor_reached).toBe(true)
    expect(result.meta.since).toBeUndefined()
  })

  test('truncates to max_posts, newest first, and says so', async () => {
    const entries = timeline('ada', 1500, 1)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
    const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 200, concurrency: 8 })
    expect(result.posts).toHaveLength(200)
    expect(result.meta.truncated).toBe(true)
    expect(result.meta.count).toBe(200)
    const newest = own('ada', entries).filter((entry) => !entry.post.reposted_by)[0]
    expect(result.posts[0].id).toBe(newest.post.id)
    expect(Date.parse(result.meta.oldest!)).toBeLessThan(Date.parse(result.meta.newest!))
  })

  test('filters replies and reposts on request', async () => {
    const entries = timeline('ada', 300, 1)
    const upstream = fakeUpstream(entries)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
    const range = { handle: 'ada', since: new Date(NOW - 200 * HOUR), until: new Date(NOW), maxPosts: 5000, concurrency: 4 }
    const originals = await importProfilePosts({ ...range, withReplies: false, withReposts: false })
    expect(originals.posts.some((post) => isReply(post) || post.reposted_by)).toBe(false)
    expect(originals.posts.length).toBeGreaterThan(50)
    vi.mocked(fetchFxProfileStatuses).mockClear()
    const replies = await importProfilePosts({ ...range, onlyReplies: true })
    expect(replies.posts.length).toBeGreaterThan(10)
    expect(replies.posts.every((post) => isReply(post) && !post.reposted_by)).toBe(true)
    expect(vi.mocked(fetchFxProfileStatuses).mock.calls.every(([, , , options]) => options?.withReplies === true)).toBe(true)
  })

  test('streams each post once as it arrives', async () => {
    const entries = timeline('ada', 300, 1)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
    const streamed: string[] = []
    const result = await importProfilePosts({ handle: 'ada', since: new Date(NOW - 250 * HOUR), until: new Date(NOW), maxPosts: 5000, onPost: (post) => streamed.push(post.id!) })
    expect(new Set(streamed).size).toBe(streamed.length)
    expect(streamed.sort()).toEqual(result.posts.map((post) => post.id).sort())
  })

  test('a quiet stretch is not mistaken for the timeline floor', async () => {
    // 60 posts per hour so windows are the 1 hour minimum, then a 6 hour gap.
    const busy = timeline('ada', 300, 1 / 60)
    const gap = 6 * HOUR
    const older = timeline('ada', 300, 1 / 60).map((entry) => {
      const sort = entry.sort - BigInt(gap + 5 * HOUR) * 4194304n
      const at = snowflakeTime(sort)
      return { sort, post: { ...entry.post, id: entry.post.reposted_by ? entry.post.id : sort.toString(), created_at: entry.post.reposted_by ? entry.post.created_at : xdate(at) } }
    })
    const entries = [...busy, ...older]
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
    const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 5000, concurrency: 8 })
    // The older half reuses the busy half's repost ids, so count unique ids.
    expect(result.posts.length).toBe(new Set(own('ada', entries).map((entry) => entry.post.id)).size)
    expect(result.meta.floor_reached).toBe(true)
  })

  test('a stream never emits more than max_posts', async () => {
    const entries = timeline('ada', 900, 1)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
    let streamed = 0
    const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 100, concurrency: 8, onPost: () => { streamed += 1 } })
    expect(streamed).toBe(100)
    expect(result.posts).toHaveLength(100)
  })

  test('stops when the caller aborts', async () => {
    const entries = timeline('ada', 900, 1)
    const upstream = fakeUpstream(entries)
    const controller = new AbortController()
    vi.mocked(fetchFxProfileStatuses).mockImplementation(async (handle, cursor, count, options) => {
      options?.signal?.throwIfAborted()
      const page = await withRetries(upstream.mock)(handle, cursor, count, options)
      if (upstream.calls() === 3) controller.abort(new Error('client left'))
      return page
    })
    await expect(importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 5000, concurrency: 2, signal: controller.signal })).rejects.toThrow('client left')
    expect(upstream.calls()).toBeLessThan(10)
  })

  test('reports truncation when the cap stops discovery at exactly max_posts', async () => {
    const entries = timeline('ada', 900, 1)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
    const all = await importProfilePosts({ handle: 'ada', since: new Date(NOW - 400 * HOUR), until: new Date(NOW), maxPosts: 5000, concurrency: 4 })
    const exact = await importProfilePosts({ handle: 'ada', since: new Date(NOW - 400 * HOUR), until: new Date(NOW), maxPosts: all.posts.length, concurrency: 4 })
    expect(exact.posts).toHaveLength(all.posts.length)
    expect(exact.meta.truncated).toBe(false)
    const capped = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 120, concurrency: 1 })
    expect(capped.posts).toHaveLength(120)
    expect(capped.meta.truncated).toBe(true)
  })

  test('never walks past the account join date', async () => {
    vi.mocked(fetchFxProfile).mockResolvedValue({ screen_name: 'ada', joined: new Date(NOW - 50 * HOUR).toUTCString() })
    const entries = timeline('ada', 40, 1)
    const upstream = fakeUpstream(entries)
    // Upstream keeps answering with the same oldest page forever: no empty page, no floor.
    vi.mocked(fetchFxProfileStatuses).mockImplementation(async (handle, cursor, count, options) => {
      const page = await withRetries(upstream.mock)(handle, cursor, count, options)
      return page.results.length ? page : { results: entries.slice(-5).map((entry) => entry.post), attempts: 1 }
    })
    const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 5000, concurrency: 4 })
    expect(result.posts.length).toBe(own('ada', entries).length)
    expect(upstream.calls()).toBeLessThan(20)
  })

  test('one failing chain stops the others', async () => {
    const entries = timeline('ada', 900, 1)
    const upstream = fakeUpstream(entries)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(async (handle, cursor, count, options) => {
      options?.signal?.throwIfAborted()
      if (upstream.calls() === 4) throw new Error('upstream exploded')
      return withRetries(upstream.mock)(handle, cursor, count, options)
    })
    await expect(importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 5000, concurrency: 4 })).rejects.toThrow('upstream exploded')
    expect(upstream.calls()).toBeLessThan(12)
  })

  test('keeps posts that X positions under a newer reply (conversation modules)', async () => {
    // Every 9th reply drags an older own post (its thread root) into the page right above it.
    const entries = timeline('ada', 600, 1).flatMap((entry, index) => {
      if (index % 9 !== 0 || !isReply(entry.post)) return [entry]
      const rootAt = snowflakeTime(entry.sort) - 5 * 24 * HOUR
      const root: Entry = { sort: entry.sort + 1n, post: { id: (snowflakeAt(rootAt) + 7n).toString(), text: `root ${index}`, created_at: xdate(rootAt), author: { screen_name: 'ada' } } }
      return [root, entry]
    })
    vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
    const since = new Date(NOW - 500 * HOUR)
    const result = await importProfilePosts({ handle: 'ada', since, until: new Date(NOW), maxPosts: 5000, concurrency: 8 })
    const expected = entries.filter((entry) => ownPost(entry.post, 'ada') && !entry.post.reposted_by && postTime(entry.post) >= since.getTime() && postTime(entry.post) <= NOW)
    const got = new Set(result.posts.map((post) => post.id))
    const missing = expected.filter((entry) => !got.has(entry.post.id!))
    expect(missing.map((entry) => entry.post.text)).toEqual([])
  })

  test('rejects an inverted range', async () => {
    await expect(importProfilePosts({ handle: 'ada', since: new Date(NOW), until: new Date(NOW - HOUR) })).rejects.toMatchObject({ code: 'invalid_option', status: 400 })
  })

  test('estimates the posting rate from own original posts only', () => {
    const entries = timeline('ada', 60, 2)
    expect(estimateRate(entries.map((entry) => entry.post), 'ada')).toBeCloseTo(0.5, 0)
    expect(estimateRate([], 'ada')).toBe(1)
  })
})
