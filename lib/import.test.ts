import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./fxtwitter.js', async () => {
  const actual = await vi.importActual<typeof import('./fxtwitter.js')>('./fxtwitter.js')
  return { ...actual, fetchFxProfile: vi.fn(), fetchFxProfileStatuses: vi.fn() }
})

import { decodeTimelineCursor, encodeTimelineCursor, snowflakeAt, snowflakeTime } from './fx-cursor.js'
import { fetchFxProfile, fetchFxProfileStatuses, type FxListResponse, type FxTweet } from './fxtwitter.js'
import { estimateRate, importProfilePosts, isReply, ownPost, postTime } from './import.js'
import { importProfilePosts as importOnMain } from './fixtures/import-main.js'
import { ConvertError } from './errors.js'

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

  test('continues a dense first window below its page-budget split', async () => {
    const entries = timeline('ada', 900, 0.001)
    const upstream = fakeUpstream(entries)
    vi.mocked(fetchFxProfileStatuses).mockImplementation(upstream.mock)
    const result = await importProfilePosts({ handle: 'ada', since: new Date(NOW - 2 * HOUR), until: new Date(NOW), maxPosts: 5000, concurrency: 1 })
    expect(result.posts.map(post => post.id).sort()).toEqual(own('ada', entries).map(entry => entry.post.id).sort())
    expect(result.meta.truncated).toBe(false)
    expect(result.meta.warnings).toBeUndefined()
    expect(upstream.calls()).toBeLessThan(40)
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
    // Same window grid as `all`: reposts just past `since` ride along with whichever page crosses it.
    const exact = await importProfilePosts({ handle: 'ada', since: new Date(NOW - 400 * HOUR), until: new Date(NOW), maxPosts: all.posts.length, concurrency: 4, tuning: { windowTargetPosts: 30 } })
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

  test('a missing timeline page leaves a warning and other windows finish', async () => {
    const entries = timeline('ada', 400, 1)
    const upstream = fakeUpstream(entries)
    let calls = 0
    vi.mocked(fetchFxProfileStatuses).mockImplementation(async (...args) => {
      calls += 1
      if (calls === 5) throw new ConvertError(502, 'page missing', 'partial_upstream_failure', 10)
      return upstream.mock(args[0], args[1])
    })
    const result = await importProfilePosts({ handle: 'ada', since: new Date(NOW - 300 * HOUR), until: new Date(NOW), maxPosts: 5000, concurrency: 4 })
    expect(result.posts.length).toBeGreaterThan(30)
    expect(result.meta.warnings).toEqual(['page_missing'])
    expect(result.meta.truncated).toBe(true)
    expect(result.meta.floor_reached).toBe(false)
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

test('a small max_posts returns what a deep walk would without waiting on chains that cannot change it', async () => {
  const entries = timeline('ada', 1500, 1)
  const upstream = fakeUpstream(entries)
  vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
  const onMain = await importOnMain({ handle: 'ada', until: new Date(NOW), maxPosts: 50, concurrency: 16 })
  // Pages from below the newest ~120 posts never answer: main would wait on
  // them forever, but nothing in them could be among the newest 50.
  const slow = entries[120].sort
  let cancelled = 0
  vi.mocked(fetchFxProfileStatuses).mockImplementation(async (handle, cursor, count, options) => {
    if (decodeTimelineCursor(cursor!)!.sortIndex > slow) return withRetries(upstream.mock)(handle, cursor, count, options)
    return new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => {
      cancelled += 1
      reject(options.signal!.reason)
    }, { once: true }))
  })
  const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 50, concurrency: 16 })
  // The newest 50 by id over the whole timeline, old-original reposts included.
  const expected = own('ada', entries).map((entry) => entry.post).sort((a, b) => (BigInt(b.id!) > BigInt(a.id!) ? 1 : -1)).slice(0, 50)
  expect(result.posts.map((post) => post.id)).toEqual(expected.map((post) => post.id))
  expect(result.posts.map((post) => post.id)).toEqual(onMain.posts.map((post) => post.id))
  expect(result.meta.truncated).toBe(true)
  expect(cancelled).toBeGreaterThan(8)
})

test('the walk does not wait for the profile, but its failure still fails the import', async () => {
  const entries = timeline('ada', 600, 1)
  vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(entries).mock))
  let answer!: (author: { screen_name: string }) => void
  vi.mocked(fetchFxProfile).mockReturnValue(new Promise((resolve) => { answer = resolve }))
  const pending = importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 200, concurrency: 4 })
  await vi.waitFor(() => expect(vi.mocked(fetchFxProfileStatuses).mock.calls.length).toBeGreaterThan(2))
  answer({ screen_name: 'ada' })
  const result = await pending
  expect(result.profile).toEqual({ screen_name: 'ada' })
  expect(result.posts).toHaveLength(200)

  vi.mocked(fetchFxProfile).mockRejectedValue(new ConvertError(503, 'X profile could not be resolved upstream. Retry shortly.', 'upstream_unavailable', 30))
  await expect(importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 200, concurrency: 4 })).rejects.toMatchObject({ code: 'upstream_unavailable' })
})

test('a third profile copy goes out when the first two miss', async () => {
  vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(timeline('ada', 100, 1)).mock))
  const miss = new ConvertError(503, 'X profile could not be resolved upstream. Retry shortly.', 'upstream_unavailable', 30)
  vi.mocked(fetchFxProfile).mockRejectedValueOnce(miss).mockRejectedValueOnce(miss).mockResolvedValueOnce({ screen_name: 'ada' })
  const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 50 })
  expect(result.profile).toEqual({ screen_name: 'ada' })
  expect(fetchFxProfile).toHaveBeenCalledTimes(3)
  // All three copies share one list of bases already asked.
  const lists = vi.mocked(fetchFxProfile).mock.calls.map((call) => call[3])
  expect(Array.isArray(lists[0])).toBe(true)
  expect(new Set(lists).size).toBe(1)
})

test('old thread roots above their replies: the walk stops once the newest 100 are settled', async () => {
  // Every 9th reply drags its 60-day-old root in right above it, so the posting
  // rate read off created_at is tiny while a page still spans about a day.
  const entries = timeline('ada', 3000, 1).flatMap((entry, index) => {
    if (index % 9 !== 0 || !isReply(entry.post)) return [entry]
    const rootAt = snowflakeTime(entry.sort) - 60 * 24 * HOUR
    return [{ sort: entry.sort + 1n, post: { id: (snowflakeAt(rootAt) + 7n).toString(), text: `root ${index}`, created_at: xdate(rootAt), author: { screen_name: 'ada' } } }, entry]
  })
  const upstream = fakeUpstream(entries)
  vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
  const onMain = await importOnMain({ handle: 'ada', until: new Date(NOW), maxPosts: 100 })
  const mainCalls = upstream.calls()
  const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 100 })
  const expected = own('ada', entries).map((entry) => entry.post).filter((post) => postTime(post) <= NOW).sort((a, b) => (BigInt(b.id!) > BigInt(a.id!) ? 1 : -1)).slice(0, 100)
  expect(result.posts.map((post) => post.id)).toEqual(expected.map((post) => post.id))
  expect(result.posts.map((post) => post.id)).toEqual(onMain.posts.map((post) => post.id))
  // About five pages hold 100 posts. The windows are 30 days long, but their
  // chains stop once the newest 100 are settled instead of walking them out.
  expect(upstream.calls() - mainCalls).toBeLessThan(mainCalls / 2)
  expect(result.meta.truncated).toBe(true)
  expect(result.meta.floor_reached).toBe(false)
  expect(Date.parse(result.meta.covered_since!)).toBeLessThanOrEqual(Date.parse(result.meta.oldest!))
})

test('a page ending in an old thread root does not make the next window skip ahead', async () => {
  const entries = timeline('ada', 400, 1)
  // The first page (30 entries) ends with three 10-day-old thread roots, each positioned
  // right above a newer reply: the page's tail time is far below its bottom.
  for (const index of [29, 28, 27]) {
    const at = entries[index].sort
    const rootAt = snowflakeTime(at) - 10 * 24 * HOUR
    entries.splice(index, 1, { sort: at, post: { id: (snowflakeAt(rootAt) + 7n).toString(), text: `old root ${index}`, created_at: xdate(rootAt), author: { screen_name: 'ada' } } })
  }
  const upstream = fakeUpstream(entries)
  vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(upstream.mock))
  const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 100, concurrency: 1 })
  const expected = own('ada', entries).map((entry) => entry.post).filter((post) => postTime(post) <= NOW).sort((a, b) => (BigInt(b.id!) > BigInt(a.id!) ? 1 : -1)).slice(0, 100)
  expect(result.posts.map((post) => post.id)).toEqual(expected.map((post) => post.id))
})

test('a reply X folds under a later one is found from the page a full walk asks between them', async () => {
  // X leaves an own reply out of any page that also holds a later reply to the
  // same conversation (live: @paulg's 2026-09-27 21:50 reply, hidden under his
  // 09-28 09:05 one), so it shows only from a page that starts between the two.
  // A dense stretch, a sparse one ending in the later reply, eleven quiet hours,
  // the hidden reply, then a dense stretch again.
  const reply = (at: number, text: string): Entry => ({ sort: snowflakeAt(at), post: { id: snowflakeAt(at).toString(), text, created_at: xdate(at), author: { screen_name: 'ada' }, replying_to: { screen_name: 'other', status: '1' } } })
  const entries: Entry[] = []
  let at = NOW
  for (let i = 0; i < 30; i += 1, at -= HOUR / 4) entries.push(reply(at, `dense ${i}`))
  for (let i = 0; i < 10; i += 1, at -= 2 * HOUR) entries.push(reply(at, `sparse ${i}`))
  const later = entries.at(-1)!
  at += 2 * HOUR - 11 * HOUR
  const hidden = reply(at, 'hidden')
  entries.push(hidden)
  for (let i = 1; i <= 200; i += 1) entries.push(reply(at - i * HOUR / 4, `older ${i}`))
  vi.mocked(fetchFxProfileStatuses).mockImplementation(async (_handle, cursor): Promise<FxListResponse<FxTweet>> => {
    const below = decodeTimelineCursor(cursor!)!.sortIndex
    const start = entries.findIndex((entry) => entry.sort < below)
    if (start < 0) return { results: [], attempts: 1 }
    let page = entries.slice(start, start + 30)
    if (page.includes(later)) page = page.filter((entry) => entry !== hidden)
    return { results: page.map((entry) => entry.post), cursor: { bottom: encodeTimelineCursor({ issuedAt: 0n, sortIndex: page.at(-1)!.sort, direction: 2 }) }, attempts: 1 }
  })
  const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 60 })
  expect(result.posts).toHaveLength(60)
  expect(result.meta.warnings).toBeUndefined()
  expect(result.posts.map((post) => post.text)).toContain('hidden')
})

test('the profile costs two requests when they answer, a third only after two misses', async () => {
  vi.mocked(fetchFxProfileStatuses).mockImplementation(withRetries(fakeUpstream(timeline('ada', 100, 1)).mock))
  await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 50 })
  expect(fetchFxProfile).toHaveBeenCalledTimes(2)
  // Each copy is one request: the caller sends the copies, not fetchFxProfile.
  expect(vi.mocked(fetchFxProfile).mock.calls.every((call) => call[2] === false)).toBe(true)

  vi.mocked(fetchFxProfile).mockClear()
  const miss = new ConvertError(503, 'X profile could not be resolved upstream. Retry shortly.', 'upstream_unavailable', 30)
  vi.mocked(fetchFxProfile).mockRejectedValue(miss)
  await expect(importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 50 })).rejects.toBe(miss)
  expect(fetchFxProfile).toHaveBeenCalledTimes(3)

  vi.mocked(fetchFxProfile).mockReset()
  // A miss then a throttle fails with the throttle, as main's one request
  // retried after the miss would: its Retry-After is what the caller must wait.
  const throttled = new ConvertError(503, 'FxTwitter is rate limiting x.md right now.', 'upstream_rate_limited', 600)
  vi.mocked(fetchFxProfile).mockRejectedValueOnce(miss).mockRejectedValueOnce(throttled)
  await expect(importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 50 })).rejects.toBe(throttled)
  // A real error is final: no third copy.
  expect(fetchFxProfile).toHaveBeenCalledTimes(2)
})

test('reaching account creation reports exhausted accessible history', async () => {
  const entries = timeline('ada', 50, 1)
  vi.mocked(fetchFxProfile).mockResolvedValue({ screen_name: 'ada', joined: xdate(NOW - 51 * HOUR) })
  vi.mocked(fetchFxProfileStatuses).mockImplementation(fakeUpstream(entries).mock)
  const result = await importProfilePosts({ handle: 'ada', until: new Date(NOW), maxPosts: 5000 })
  expect(result.meta.floor_reached).toBe(true)
  expect(result.meta.truncated).toBe(false)
})
