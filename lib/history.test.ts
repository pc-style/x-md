import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./import.js', async () => {
  const actual = await vi.importActual<typeof import('./import.js')>('./import.js')
  return { ...actual, importProfilePosts: vi.fn() }
})

import { importProfilePosts, type ImportInput, type ImportResult } from './import.js'
import type { FxTweet } from './fxtwitter.js'
import { importWithHistory, readHistoryIndex, resetHistoryStore } from './history.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 9, 12)
const TWEPOCH = 1288834974657
const idAt = (ms: number) => (BigInt(ms - TWEPOCH) << 22n).toString()

/** One own post per hour; every 4th is a reply. */
function post(ms: number, handle = 'ada'): FxTweet {
  const reply = Math.floor(ms / HOUR) % 4 === 0
  return { id: idAt(ms), text: `post ${ms}`, created_at: new Date(ms).toUTCString(), author: { screen_name: handle }, replying_to: reply ? { screen_name: 'bob', status: '1' } : null }
}

/** A fake engine: returns every hourly post inside [since, until], capped, and reports floor at FLOOR. */
const FLOOR = NOW - 1000 * HOUR
function fakeEngine(input: ImportInput): Promise<ImportResult> {
  const until = input.until?.getTime() ?? NOW
  const since = Math.max(input.since?.getTime() ?? FLOOR, FLOOR)
  const posts: FxTweet[] = []
  for (let ms = Math.floor(until / HOUR) * HOUR; ms >= since && posts.length < (input.maxPosts ?? 500); ms -= HOUR) posts.push(post(ms))
  for (const p of posts) input.onPost?.(p)
  const meta = { handle: input.handle, count: posts.length, until: new Date(until).toISOString(), truncated: false, floor_reached: since <= FLOOR && input.since === undefined, with_replies: true, with_reposts: true, only_replies: false, concurrency: 16, windows: Math.ceil(posts.length / 30), pages: Math.ceil(posts.length / 30) + 1, retried_pages: 0, duration_ms: 5, estimated_rate_per_hour: 1, source: 'fxtwitter' as const }
  return Promise.resolve({ profile: { screen_name: 'ada' }, posts, meta })
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  vi.mocked(importProfilePosts).mockReset().mockImplementation(fakeEngine)
  resetHistoryStore()
})

describe('importWithHistory', () => {
  test('first import walks the range and fills the archive', async () => {
    const result = await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    expect(result.posts).toHaveLength(101)
    expect(result.meta.archive.walked).toEqual(['refresh'])
    expect(result.meta.archive.added).toBe(101)
    expect(result.meta.archive.served).toBe(0)
    const index = await readHistoryIndex('ada')
    expect(index).toMatchObject({ handle: 'ada', count: 101, floor_reached: false })
    expect(index?.newest).toBe(new Date(NOW).toISOString())
    expect(index?.oldest).toBe(new Date(NOW - 100 * HOUR).toISOString())
  })

  test('a later import only tops up the gap and serves the rest from the archive', async () => {
    await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    vi.mocked(importProfilePosts).mockClear()
    const later = NOW + 10 * HOUR
    const streamed: string[] = []
    const result = await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(later), maxPosts: 5000, onPost: (p) => streamed.push(p.id!) })
    expect(result.meta.archive.walked).toEqual(['top-up'])
    const call = vi.mocked(importProfilePosts).mock.calls[0][0]
    // Walked from the archive edge (minus the overlap), not from `since`.
    expect(call.since!.getTime()).toBe(NOW - 6 * HOUR)
    expect(call.until!.getTime()).toBe(later)
    expect(result.posts).toHaveLength(111)
    // The 6 h overlap re-fetched hours -6…0 (7 posts); everything else came from the archive.
    expect(result.meta.archive.served).toBe(111 - 7 - 10)
    expect(new Set(streamed).size).toBe(111)
    expect(streamed.length).toBe(111)
  })

  test('an older since backfills below the archive', async () => {
    await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    vi.mocked(importProfilePosts).mockClear()
    const result = await importWithHistory({ handle: 'ada', since: new Date(NOW - 300 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    expect(result.meta.archive.walked).toEqual(['backfill'])
    const call = vi.mocked(importProfilePosts).mock.calls[0][0]
    expect(call.since!.getTime()).toBe(NOW - 300 * HOUR)
    expect(call.until!.getTime()).toBe(NOW - 100 * HOUR + 6 * HOUR)
    expect(result.posts).toHaveLength(301)
    expect((await readHistoryIndex('ada'))?.count).toBe(301)
  })

  test('no since keeps backfilling until the floor, then stops asking', async () => {
    await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    const full = await importWithHistory({ handle: 'ada', until: new Date(NOW), maxPosts: 5000 })
    expect(full.meta.archive.walked).toEqual(['backfill'])
    expect(full.meta.floor_reached).toBe(true)
    expect(full.posts).toHaveLength(1001)
    vi.mocked(importProfilePosts).mockClear()
    const again = await importWithHistory({ handle: 'ada', until: new Date(NOW), maxPosts: 5000 })
    expect(again.meta.archive.walked).toEqual([])
    expect(importProfilePosts).not.toHaveBeenCalled()
    expect(again.posts).toHaveLength(1001)
    expect(again.meta.archive.served).toBe(1001)
    // A minute later the same request tops up again (the archive is no longer fresh).
    vi.setSystemTime(NOW + 2 * 60_000)
    const minuteLater = await importWithHistory({ handle: 'ada', until: new Date(NOW + 2 * 60_000), maxPosts: 5000 })
    expect(minuteLater.meta.archive.walked).toEqual(['top-up'])
  })

  test('filters and max_posts apply when serving from the archive', async () => {
    await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    const replies = await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 10, onlyReplies: true })
    expect(replies.posts).toHaveLength(10)
    expect(replies.posts.every((p) => p.replying_to)).toBe(true)
    expect(replies.meta.truncated).toBe(true)
    const originals = await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000, withReplies: false })
    expect(originals.posts.some((p) => p.replying_to)).toBe(false)
  })

  test('a backfill the result cap prevents is reported as truncation', async () => {
    await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    vi.mocked(importProfilePosts).mockClear()
    // The archive alone fills max_posts, so the older half of the range is never walked.
    const result = await importWithHistory({ handle: 'ada', since: new Date(NOW - 200 * HOUR), until: new Date(NOW), maxPosts: 101 })
    expect(result.posts).toHaveLength(101)
    expect(result.meta.archive.walked).toEqual([])
    expect(result.meta.truncated).toBe(true)
  })

  test('coverage, not post dates, decides the gaps: a repeat of the same request walks nothing older', async () => {
    // since falls between two hourly posts, so the oldest post is newer than since.
    const since = new Date(NOW - 100 * HOUR - 30 * 60_000)
    await importWithHistory({ handle: 'ada', since, until: new Date(NOW), maxPosts: 5000 })
    const index = await readHistoryIndex('ada')
    expect(index?.covered_since).toBe(since.toISOString())
    expect(index?.covered_until).toBe(new Date(NOW).toISOString())
    vi.setSystemTime(NOW + 2 * 60_000)
    vi.mocked(importProfilePosts).mockClear()
    const again = await importWithHistory({ handle: 'ada', since, until: new Date(NOW + 2 * 60_000), maxPosts: 5000 })
    expect(again.meta.archive.walked).toEqual(['top-up'])
    expect(vi.mocked(importProfilePosts).mock.calls[0][0].since!.getTime()).toBe(NOW - 6 * HOUR)
  })

  test('refresh re-walks the range', async () => {
    await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000 })
    vi.mocked(importProfilePosts).mockClear()
    const result = await importWithHistory({ handle: 'ada', since: new Date(NOW - 100 * HOUR), until: new Date(NOW), maxPosts: 5000, refresh: true })
    expect(result.meta.archive.walked).toEqual(['refresh'])
    expect(vi.mocked(importProfilePosts).mock.calls[0][0].since!.getTime()).toBe(NOW - 100 * HOUR)
    expect(result.posts).toHaveLength(101)
  })
})
