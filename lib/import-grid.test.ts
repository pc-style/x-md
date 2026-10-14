import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('./fxtwitter.js', async () => {
  const actual = await vi.importActual<typeof import('./fxtwitter.js')>('./fxtwitter.js')
  return { ...actual, fetchFxProfile: vi.fn(), fetchFxProfileStatuses: vi.fn() }
})

import { ConvertError } from './errors.js'
import { decodeTimelineCursor, encodeTimelineCursor, snowflakeAt } from './fx-cursor.js'
import { fetchFxProfile, fetchFxProfileStatuses, type FxListResponse, type FxTweet } from './fxtwitter.js'
import { IMPORT_DEFAULT_CONCURRENCY, importProfilePosts, type ImportInput, type ImportResult } from './import.js'
import { importProfilePosts as importOnMain } from './fixtures/import-main.js'

/*
 * Differential check of the walker against main's (lib/fixtures/import-main.ts).
 * X answers a span differently from cursor to cursor: an own reply is left out
 * of any page that also holds a newer own reply to the same conversation, so
 * which replies a walk finds depends on exactly where its pages start. Both
 * walkers run over the same synthetic timelines, with each answer and its
 * latency a function of the cursor alone, so they see the same upstream at the
 * same moments. Main's own grid depends on response timing past the windows it
 * cuts up front; under a fixed timing it is one grid, and the live walker must
 * ask from no start main does not and return exactly main's posts.
 */

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 1, 12)
const PAGE = 30
const xdate = (ms: number) => new Date(ms).toUTCString()

interface Entry { sort: bigint; post: FxTweet; conversation?: number }
interface Timeline { entries: Entry[]; joined?: number; seed: number; bottom: 'raw' | 'visible'; misses: boolean }

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hash(seed: number, text: string): number {
  let h = (2166136261 ^ seed) >>> 0
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0
  return h
}

const own = (id: bigint, at: number, text: string, extra: Partial<FxTweet> = {}): FxTweet => ({ id: id.toString(), text, created_at: xdate(at), author: { screen_name: 'ada' }, ...extra })

/**
 * Bursts, steady stretches and quiet gaps of days; replies grouped into
 * conversations that run over hours to days; reposts of old posts; other
 * people's conversation parents; and old thread roots placed right above the
 * reply that brought them in.
 */
function randomTimeline(seed: number): Timeline {
  const rand = mulberry32(seed)
  const count = 120 + Math.floor(rand() * 1100)
  const gaps = [2 * 60_000, 15 * 60_000, HOUR, 4 * HOUR, DAY]
  let gap = gaps[Math.floor(rand() * gaps.length)]
  const replyShare = 0.2 + rand() * 0.5
  const fold = rand() * 0.6
  const conversations: number[] = []
  let nextConversation = 1
  let at = NOW - Math.floor(rand() * 6 * HOUR)
  const entries: Entry[] = []
  for (let i = 0; i < count; i += 1) {
    if (rand() < 0.04) gap = gaps[Math.floor(rand() * gaps.length)]
    if (rand() < 0.01) at -= Math.floor((1 + rand() * 20) * DAY)
    at -= Math.max(1000, Math.floor(-Math.log(1 - rand()) * gap))
    const sort = snowflakeAt(at) + BigInt(i)
    const kind = rand()
    if (kind < 0.1) {
      const originalAt = at - Math.floor((1 + rand() * 900) * DAY)
      entries.push({ sort, post: { id: (snowflakeAt(originalAt) + BigInt(i)).toString(), text: `rt ${i}`, created_at: xdate(originalAt), author: { screen_name: 'someone' }, reposted_by: { screen_name: 'ada' } } })
    } else if (kind < 0.15) {
      entries.push({ sort, post: { id: sort.toString(), text: `parent ${i}`, created_at: xdate(at), author: { screen_name: 'other' } } })
    } else if (kind < 0.15 + replyShare) {
      let conversation: number
      if (conversations.length > 0 && rand() < fold) conversation = conversations[Math.floor(rand() * conversations.length)]
      else {
        conversation = nextConversation++
        conversations.push(conversation)
        if (conversations.length > 6) conversations.shift()
      }
      if (rand() < 0.04) {
        const rootAt = at - Math.floor((1 + rand() * 60) * DAY)
        entries.push({ sort: sort + 1n, post: own(snowflakeAt(rootAt) + BigInt(i), rootAt, `root ${i}`) })
      }
      entries.push({ sort, conversation, post: own(sort, at, `reply ${i}`, { replying_to: { screen_name: 'other', status: '1' } }) })
    } else {
      entries.push({ sort, post: own(sort, at, `post ${i}`) })
    }
  }
  entries.sort((a, b) => (a.sort > b.sort ? -1 : 1))
  const ownTimes = entries.filter((entry) => !entry.post.reposted_by && entry.post.author?.screen_name === 'ada').map((entry) => Date.parse(entry.post.created_at!))
  const joined = rand() < 0.2 ? undefined : Math.min(...ownTimes) - Math.floor(rand() * 2 * DAY)
  return { entries, joined, seed, bottom: rand() < 0.5 ? 'raw' : 'visible', misses: rand() < 0.3 }
}

/** One page below `cursor`: thirty entries, less every own reply a newer one on the page folds away. */
function serve(timeline: Timeline, cursor: string): FxListResponse<FxTweet> {
  const below = decodeTimelineCursor(cursor)!.sortIndex
  if (timeline.misses && hash(timeline.seed, `miss:${below}`) % 40 === 0) throw new ConvertError(502, 'X timeline page could not be resolved upstream.', 'partial_upstream_failure', 10)
  const { entries } = timeline
  let lo = 0
  let hi = entries.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (entries[mid].sort < below) hi = mid
    else lo = mid + 1
  }
  const raw = entries.slice(lo, lo + PAGE)
  if (raw.length === 0) return { results: [], attempts: 1 }
  const folded = new Set<number>()
  const visible = raw.filter((entry) => {
    if (entry.conversation === undefined) return true
    if (folded.has(entry.conversation)) return false
    folded.add(entry.conversation)
    return true
  })
  const last = timeline.bottom === 'raw' ? raw.at(-1)! : visible.at(-1)!
  return { results: visible.map((entry) => entry.post), cursor: { bottom: encodeTimelineCursor({ issuedAt: 0n, sortIndex: last.sort, direction: 2 }) }, attempts: 1 }
}

let timeline: Timeline
let starts: bigint[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.mocked(fetchFxProfileStatuses).mockImplementation((_handle, cursor, _count, options) => {
    // A forged cursor carries the time it was made, so answers and latency key on where it starts.
    const start = decodeTimelineCursor(cursor!)!.sortIndex
    starts.push(start)
    const signal = options?.signal
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal!.reason)
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        try { resolve(serve(timeline, cursor!)) } catch (error) { reject(error) }
      }, 600 + (hash(timeline.seed, String(start)) % 2000))
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  })
  vi.mocked(fetchFxProfile).mockImplementation(() => new Promise((resolve) => {
    setTimeout(() => resolve({ screen_name: 'ada', joined: timeline.joined === undefined ? undefined : xdate(timeline.joined) }), 400 + (timeline.seed % 2400))
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

/** Run a walk to the end on the fake clock, one timer at a time, settling every promise in between. */
async function drive<T>(promise: Promise<T>): Promise<T> {
  let done = false
  promise.then(() => { done = true }, () => { done = true })
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  for (await flush(); !done; await flush()) {
    if (vi.getTimerCount() === 0) throw new Error('walk stalled with no timer pending')
    vi.advanceTimersToNextTimer()
  }
  return promise
}

async function run(walker: (input: ImportInput) => Promise<ImportResult>, input: ImportInput) {
  starts = []
  try {
    return { result: await drive(walker(input)), starts: [...starts] }
  } catch (error) {
    return { error, starts: [...starts] }
  }
}

interface Comparison { mainRequests: number; headRequests: number; mainIds: string[]; headIds: string[]; outside: bigint[]; outsideAboveOldest: bigint[]; failed: boolean }

async function compare(input: ImportInput): Promise<Comparison> {
  const main = await run(importOnMain, input)
  const head = await run(importProfilePosts, input)
  // A miss on the very first page fails both walks, and with the same error.
  if (main.error || head.error) expect((head.error as ConvertError | undefined)?.code).toBe((main.error as ConvertError | undefined)?.code)
  const mainPosts = main.result?.posts ?? []
  const asked = new Set(main.starts)
  // Main's oldest returned post by position, as `meta.oldest` counts it: a
  // repost carries its original's id, which can predate the account.
  const originals = mainPosts.filter((post) => !post.reposted_by)
  const oldest = originals.length > 0 ? BigInt(originals.at(-1)!.id!) : 0n
  const outside = head.starts.filter((start) => !asked.has(start))
  return {
    mainRequests: main.starts.length,
    headRequests: head.starts.length,
    mainIds: mainPosts.map((post) => post.id!),
    headIds: (head.result?.posts ?? []).map((post) => post.id!),
    outside,
    outsideAboveOldest: outside.filter((start) => start >= oldest),
    failed: Boolean(main.error),
  }
}

const TIMELINES = 300

test(`asks only main's pages and returns main's posts over ${TIMELINES} random timelines with folded replies`, async () => {
  const limits = [20, 50, 100, 200, 500]
  const totals = { walks: 0, failed: 0, mainRequests: 0, headRequests: 0, outsideBelowJoin: 0, folded: 0 }
  for (let seed = 1; seed <= TIMELINES; seed += 1) {
    timeline = randomTimeline(seed)
    const rand = mulberry32(seed * 7919)
    const pick = <T,>(values: T[]) => values[Math.floor(rand() * values.length)]
    const filters: Array<Partial<ImportInput>> = [{}, { withReplies: false }, { onlyReplies: true }, { withReposts: false }]
    const configs: ImportInput[] = [
      { handle: 'ada', until: new Date(NOW), maxPosts: pick(limits), concurrency: 1 },
      { handle: 'ada', until: new Date(NOW), maxPosts: pick(limits), concurrency: IMPORT_DEFAULT_CONCURRENCY },
      { handle: 'ada', until: new Date(NOW), maxPosts: pick([200, 500]), concurrency: IMPORT_DEFAULT_CONCURRENCY, ...pick(filters) },
      { handle: 'ada', since: new Date(NOW - Math.floor((1 + rand() * 20) * DAY)), until: new Date(NOW - Math.floor(rand() * 12 * HOUR)), maxPosts: pick([100, 5000]), concurrency: pick([1, 4, IMPORT_DEFAULT_CONCURRENCY]) },
    ]
    for (const input of configs) {
      const result = await compare(input)
      const where = `seed ${seed}, ${JSON.stringify({ ...input, until: undefined, since: input.since?.toISOString() })}`
      expect(result.outsideAboveOldest, where).toEqual([])
      // A start main never asked lies below the account's first post: the walk
      // went on past the join date before the profile had said where it was.
      const join = timeline.joined === undefined ? 0n : snowflakeAt(timeline.joined + 1)
      expect(result.outside.filter((start) => start > join), where).toEqual([])
      expect(result.headIds, where).toEqual(result.mainIds)
      totals.walks += 1
      if (result.failed) totals.failed += 1
      totals.mainRequests += result.mainRequests
      totals.headRequests += result.headRequests
      totals.outsideBelowJoin += result.outside.length
    }
    totals.folded += timeline.entries.filter((entry) => entry.conversation !== undefined).length
  }
  console.info('[import-grid]', JSON.stringify(totals))
  expect(totals.headRequests).toBeLessThan(totals.mainRequests)
}, 120_000)

test("the reply main finds from between two of a conversation's replies is found at either concurrency", async () => {
  // Reviewer's case: 500 hourly posts, thirty to a page, limit 100. The reply at
  // 57 is hidden from any page that also holds the newer reply at 55; main at
  // concurrency 1 asks from 0, 30, 56 and 86, and only the page from 56 shows it.
  const entries: Entry[] = []
  for (let i = 0; i < 500; i += 1) {
    const at = NOW - HOUR / 2 - i * HOUR
    const sort = snowflakeAt(at)
    const reply = i === 55 || i === 57
    entries.push({ sort, conversation: reply ? 1 : undefined, post: own(sort, at, `post ${i}`, reply ? { replying_to: { screen_name: 'other', status: '1' } } : {}) })
  }
  const hidden = entries[57].post.id
  for (const bottom of ['raw', 'visible'] as const) {
    timeline = { entries, seed: 5757, bottom, misses: false }
    for (const concurrency of [1, IMPORT_DEFAULT_CONCURRENCY]) {
      const result = await compare({ handle: 'ada', until: new Date(NOW), maxPosts: 100, concurrency })
      expect(result.outside).toEqual([])
      expect(result.headIds).toEqual(result.mainIds)
      if (concurrency === 1) expect(result.mainIds).toContain(hidden)
    }
  }
})
