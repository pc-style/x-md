import { afterEach, beforeEach, expect, test, vi } from 'vitest'

vi.mock('./import.js', async () => {
  const actual = await vi.importActual<typeof import('./import.js')>('./import.js')
  return { ...actual, importProfilePosts: vi.fn() }
})

import { importProfilePosts } from './import.js'
import type { FxTweet } from './fxtwitter.js'
import { importWithHistory, resetHistoryStore } from './history.js'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 9, 12)
const TWEPOCH = 1288834974657
const idAt = (ms: number, sequence = 0) => ((BigInt(ms - TWEPOCH) << 22n) + BigInt(sequence)).toString()
const post = (ms: number, sequence = 0, likes = 0): FxTweet => ({ id: idAt(ms, sequence), created_at: new Date(ms).toUTCString(), author: { screen_name: 'ada' }, likes })

/** Just enough of the Upstash REST pipeline for the archive, its lock and the import slot. */
function fakeUpstash() {
  const strings = new Map<string, string>()
  const hashes = new Map<string, Map<string, string>>()
  const zsets = new Map<string, Map<string, number>>()
  const hash = (key: string) => hashes.get(key) ?? hashes.set(key, new Map()).get(key)!
  const zset = (key: string) => zsets.get(key) ?? zsets.set(key, new Map()).get(key)!
  const run = (command: (string | number)[]): unknown => {
    const [name, ...args] = command.map(String)
    switch (name) {
      case 'SET': if (strings.has(args[0])) return null; strings.set(args[0], args[1]); return 'OK'
      case 'EVAL': if (args[0].includes('ZREMRANGEBYSCORE')) return 1; if (strings.get(args[2]) === args[3]) strings.delete(args[2]); return 1
      case 'ZREM': return 1
      case 'HGETALL': return [...(hashes.get(args[0]) ?? [])].flat()
      case 'HSET': { const h = hash(args[0]); for (let i = 1; i < args.length; i += 2) h.set(args[i], args[i + 1]); return 1 }
      case 'HMGET': return args.slice(1).map((field) => hashes.get(args[0])?.get(field) ?? null)
      case 'ZADD': { const z = zset(args[0]); for (let i = 1; i < args.length; i += 2) z.set(args[i + 1], Number(args[i])); return 1 }
      case 'ZCARD': return zsets.get(args[0])?.size ?? 0
      case 'ZRANGE': {
        const [key, max, min, ...flags] = args
        const limit = flags.indexOf('LIMIT')
        const offset = limit >= 0 ? Number(flags[limit + 1]) : 0
        const count = limit >= 0 ? Number(flags[limit + 2]) : Infinity
        const page = [...(zsets.get(key) ?? [])].filter(([, score]) => score >= Number(min) && score <= Number(max))
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).slice(offset, offset + count)
        return flags.includes('WITHSCORES') ? page.flatMap(([member, score]) => [member, String(score)]) : page.map(([member]) => member)
      }
      default: throw new Error(`unsupported ${name}`)
    }
  }
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify((JSON.parse(String(init?.body)) as (string | number)[][]).map((command) => ({ result: run(command) })))))
  return { fetch, hashes, zsets }
}

let upstash: ReturnType<typeof fakeUpstash>
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  upstash = fakeUpstash()
  vi.stubGlobal('fetch', upstash.fetch)
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'token')
  resetHistoryStore()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('a warm Redis archive answers with the stored order, the walk laid over a bounded read', async () => {
  // 120 hourly posts, two of them sharing a second so the member order breaks the tie.
  const archived = Array.from({ length: 120 }, (_, i) => post(NOW - (i + 1) * HOUR))
  archived.push(post(NOW - 3 * HOUR, 1))
  vi.mocked(importProfilePosts).mockImplementation(async (input) => {
    const posts = input.since ? [post(NOW - 0.5 * HOUR), post(NOW - 2 * HOUR, 0, 99)] : archived
    return { profile: { screen_name: 'ada' }, posts, meta: { handle: 'ada', count: posts.length, until: new Date(NOW).toISOString(), truncated: false, floor_reached: !input.since, with_replies: true, with_reposts: true, only_replies: false, concurrency: 16, windows: 1, pages: 1, retried_pages: 0, duration_ms: 1, estimated_rate_per_hour: 1, source: 'fxtwitter' } }
  })
  await importWithHistory({ handle: 'ada', until: new Date(NOW - 0.9 * HOUR), maxPosts: 5000 })
  // The body of one archived post went missing; a read skips it rather than shifting the rest.
  upstash.hashes.get('hist:ada:posts')!.delete(idAt(NOW - 5 * HOUR))
  vi.setSystemTime(NOW + 5 * 60_000)

  upstash.fetch.mockClear()
  const result = await importWithHistory({ handle: 'ada', until: new Date(NOW), maxPosts: 5 })
  expect(result.meta.archive.walked).toEqual(['top-up'])
  expect(result.posts.map((p) => p.id)).toEqual([idAt(NOW - 0.5 * HOUR), idAt(NOW - HOUR), idAt(NOW - 2 * HOUR), idAt(NOW - 3 * HOUR, 1), idAt(NOW - 3 * HOUR)])
  // The walked copy replaces the archived one.
  expect(result.posts[2].likes).toBe(99)
  expect(result.meta.truncated).toBe(true)
  expect(result.meta.archive.served).toBe(3)
  // Bounded range reads only, never the whole archive: the hole left the first page one short.
  const reads = upstash.fetch.mock.calls.map(([, init]) => String(init?.body)).filter((body) => body.includes('"ZRANGE"'))
  expect(reads).toHaveLength(2)
  expect(reads[0]).toContain('"LIMIT",0,6')
  expect(reads[1]).toContain('"LIMIT",6,6')
})

test('a failed archive write holds the handle lock until every chunk it sent has landed', async () => {
  // 151 posts: a 150-post chunk and a 1-post chunk, written in parallel.
  const posts = Array.from({ length: 151 }, (_, i) => post(NOW - (i + 1) * 60_000))
  vi.mocked(importProfilePosts).mockImplementation(async () => ({ profile: { screen_name: 'ada' }, posts, meta: { handle: 'ada', count: posts.length, until: new Date(NOW).toISOString(), truncated: false, floor_reached: true, with_replies: true, with_reposts: true, only_replies: false, concurrency: 16, windows: 1, pages: 6, retried_pages: 0, duration_ms: 1, estimated_rate_per_hour: 60, source: 'fxtwitter' } }))
  const run = upstash.fetch.getMockImplementation()!
  let landed = false
  upstash.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const zadd = (JSON.parse(String(init?.body)) as (string | number)[][]).find((command) => command[0] === 'ZADD')
    if (zadd && zadd.length === 2 + 2 * 150) return new Response('busy', { status: 500 })
    if (!zadd) return run(url, init)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const response = await run(url, init)
    landed = true
    return response
  })
  await expect(importWithHistory({ handle: 'ada', until: new Date(NOW), maxPosts: 5000 })).rejects.toThrow('redis HTTP 500')
  expect(landed).toBe(true)
})
