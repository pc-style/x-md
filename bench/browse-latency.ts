/**
 * Latency benchmark for the browse routes (`/search`, `/:handle/followers`,
 * `/:handle/following`): drives the real `api/browse.ts` handler with the
 * network replaced by in-process stand-ins whose latency is configurable, so
 * the cost of x.md's own request path (store round trips, admission, render)
 * can be measured repeatably and separately from the upstream providers.
 *
 *   bun bench/browse-latency.ts [--runs 40] [--redis-ms 12] [--x-ms 450] [--fx-ms 600] [--fx-slow-ms 2800] [--json out.json]
 *
 * Defaults model production as measured on 2026-10-13 from fra1: a store round
 * trip of roughly 12 ms, an own-account search call of ~450 ms, and an
 * FxTwitter list page of ~600 ms when it is quick. The "slow upstream"
 * scenario makes three of every five list pages take `--fx-slow-ms` instead,
 * which is the share of slow pages seen that day (0.6 s, 1.8 s, 2.0 s, 2.4 s,
 * 2.8 s, 3.0 s, 3.1 s, 3.5 s, 4.0 s over ten samples). Every store call is
 * counted, so the round trip column is exact whatever the simulated latency.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { writeFile } from 'node:fs/promises'
import type { VercelRequest, VercelResponse } from '@vercel/node'

const args = process.argv.slice(2)
const flag = (name: string, fallback: number): number => {
  const index = args.indexOf(`--${name}`)
  const value = index >= 0 ? Number(args[index + 1]) : NaN
  return Number.isFinite(value) ? value : fallback
}
const options = {
  runs: flag('runs', 40),
  redisMs: flag('redis-ms', 12),
  xMs: flag('x-ms', 450),
  fxMs: flag('fx-ms', 600),
  fxSlowMs: flag('fx-slow-ms', 2800),
  json: args.includes('--json') ? args[args.indexOf('--json') + 1] : undefined,
}

// The modules read their configuration at import time, so set it first.
process.env.KV_REST_API_URL = 'https://redis.bench.invalid'
process.env.KV_REST_API_TOKEN = 'bench-token'
process.env.VERCEL = '1'
process.env.X_SEARCH_SESSIONS_JSON = JSON.stringify([{ id: 'bench-a', authToken: 'benchauthtoken', ct0: 'benchct0' }])
process.env.FXTWITTER_BASE_URL = 'https://fx.bench.invalid,https://fx2.bench.invalid'
for (const name of ['CACHE_DISABLED', 'CACHE_TTL_SECONDS', 'FIRECRAWL_API_KEY', 'POSTHOG_PROJECT_TOKEN', 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'VERCEL_ENV', 'X_MD_REQUIRE_API_KEY']) delete process.env[name]

type Reply = { result?: unknown; error?: string }

/** Enough of the Upstash REST pipeline for the request path: strings with expiry, counters, sets. */
class FakeRedis {
  strings = new Map<string, { value: string; expiresAt?: number }>()
  sets = new Map<string, Set<string>>()

  private read(key: string): string | undefined {
    const entry = this.strings.get(key)
    if (!entry) return undefined
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.strings.delete(key)
      return undefined
    }
    return entry.value
  }

  exec(command: (string | number)[]): Reply {
    const [name, ...rest] = command.map(String)
    switch (name) {
      case 'GET': return { result: this.read(rest[0]!) ?? null }
      case 'MGET': return { result: rest.map((key) => this.read(key) ?? null) }
      case 'SET': {
        const ex = rest.indexOf('EX')
        this.strings.set(rest[0]!, { value: rest[1]!, expiresAt: ex >= 0 ? Date.now() + Number(rest[ex + 1]) * 1000 : undefined })
        return { result: 'OK' }
      }
      case 'DEL': {
        const existed = this.strings.delete(rest[0]!) || this.sets.delete(rest[0]!)
        return { result: existed ? 1 : 0 }
      }
      case 'INCR':
      case 'DECR': {
        const current = Number(this.read(rest[0]!) ?? 0)
        const next = name === 'INCR' ? current + 1 : current - 1
        const entry = this.strings.get(rest[0]!)
        this.strings.set(rest[0]!, { value: String(next), expiresAt: entry?.expiresAt })
        return { result: next }
      }
      case 'EXPIRE': {
        const entry = this.strings.get(rest[0]!)
        if (!entry) return { result: 0 }
        if (rest.includes('NX') && entry.expiresAt !== undefined) return { result: 0 }
        entry.expiresAt = Date.now() + Number(rest[1]) * 1000
        return { result: 1 }
      }
      case 'SADD': {
        const set = this.sets.get(rest[0]!) ?? new Set<string>()
        const added = set.has(rest[1]!) ? 0 : 1
        set.add(rest[1]!)
        this.sets.set(rest[0]!, set)
        return { result: added }
      }
      case 'SREM': return { result: this.sets.get(rest[0]!)?.delete(rest[1]!) ? 1 : 0 }
      case 'SMEMBERS': return { result: [...(this.sets.get(rest[0]!) ?? [])] }
      default: return { error: `unsupported command ${name}` }
    }
  }

  /** Drop the counters only, so a scenario can keep its cache and breaker state between runs. */
  clearCounters(): void {
    for (const key of [...this.strings.keys()]) if (key.startsWith('rl:')) this.strings.delete(key)
  }
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve())
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fxUser = (n: number) => ({
  id: String(1_000_000 + n), name: `Bench User ${n}`, screen_name: `benchuser_${n}`, url: `https://x.com/benchuser_${n}`,
  description: 'Builds things on the internet. Opinions are my own, retweets are not endorsements.',
  followers: 1234 + n * 17, following: 321 + n, likes: 99, media_count: 12, statuses: 4567 + n,
  joined: 'Mon Jan 01 00:00:00 +0000 2018', avatar_url: `https://pbs.twimg.com/profile_images/${n}/avatar.jpg`,
  banner_url: `https://pbs.twimg.com/profile_banners/${n}/banner`, protected: false, verification: { verified: n % 5 === 0 },
})
const fxPost = (n: number) => ({
  id: String(1_800_000_000_000_000_000n + BigInt(n)), url: `https://x.com/benchuser_${n}/status/${1_800_000_000_000_000_000n + BigInt(n)}`,
  text: `Post number ${n} about markdown, agents and other things worth reading twice.`,
  created_at: 'Mon Oct 13 10:00:00 +0000 2026', created_timestamp: 1_791_900_000 + n,
  author: { id: String(1_000_000 + n), name: `Bench User ${n}`, screen_name: `benchuser_${n}`, url: `https://x.com/benchuser_${n}`, avatar_url: `https://pbs.twimg.com/profile_images/${n}/avatar.jpg` },
  likes: 10 + n, retweets: 2, replies: 1, views: 1000 + n, lang: 'en',
})
/** One X SearchTimeline page in the shape the scraper parses. */
const xTimeline = (count: number) => ({
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{
    type: 'TimelineAddEntries',
    entries: [
      ...Array.from({ length: count }, (_, i) => ({
        entryId: `tweet-${i}`,
        content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweetDisplayType: 'Tweet', tweet_results: { result: {
          rest_id: String(1_800_000_000_000_000_000n + BigInt(i)),
          core: { user_results: { result: { rest_id: String(1_000_000 + i), core: { screen_name: `benchuser_${i}`, name: `Bench User ${i}` }, avatar: { image_url: `https://pbs.twimg.com/profile_images/${i}/avatar_normal.jpg` }, legacy: { screen_name: `benchuser_${i}`, name: `Bench User ${i}`, profile_image_url_https: `https://pbs.twimg.com/profile_images/${i}/avatar_normal.jpg` } } } },
          views: { count: String(1000 + i) },
          legacy: {
            id_str: String(1_800_000_000_000_000_000n + BigInt(i)), conversation_id_str: String(1_800_000_000_000_000_000n + BigInt(i)), user_id_str: String(1_000_000 + i),
            full_text: `Post number ${i} about markdown, agents and other things worth reading twice.`, created_at: 'Mon Oct 13 10:00:00 +0000 2026',
            favorite_count: 10 + i, retweet_count: 2, reply_count: 1, bookmark_count: 0, lang: 'en', display_text_range: [0, 70],
            entities: { hashtags: [], user_mentions: [], urls: [] },
          },
        } } } },
      })),
      { entryId: 'cursor-top-1', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Top', value: 'DAACCgABtop' } },
      { entryId: 'cursor-bottom-1', content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value: 'DAACCgABbottom' } },
    ],
  }] } } } },
})

const stats = { redis: 0, fx: 0, x: 0 }
let redis = new FakeRedis()
let fxSearchUp = false
/** When set, list pages follow the slow-page model: pages 1, 2 and 3 of every 5 are slow. */
let fxSlowPages = false
let fxPages = 0
const fxDelay = (signal: AbortSignal | null | undefined, ms: number) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')) }, { once: true })
})

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.host === 'redis.bench.invalid') {
    stats.redis += 1
    await sleep(options.redisMs)
    const commands = JSON.parse(String(init?.body)) as (string | number)[][]
    return json(commands.map((command) => redis.exec(command)))
  }
  if (url.host === 'fx.bench.invalid' || url.host === 'fx2.bench.invalid') {
    stats.fx += 1
    const count = Number(url.searchParams.get('count') ?? 20)
    if (/\/(followers|following)$/.test(url.pathname)) {
      fxPages += 1
      await fxDelay(init?.signal, fxSlowPages && fxPages % 5 !== 0 && fxPages % 5 !== 4 ? options.fxSlowMs : options.fxMs)
      return json({ code: 200, results: Array.from({ length: Math.min(count, 50) }, (_, i) => fxUser(i)), cursor: { top: null, bottom: `fxcursor-${count}` } })
    }
    await sleep(options.fxMs)
    if (url.pathname === '/2/search') return fxSearchUp ? json({ code: 200, results: Array.from({ length: Math.min(count, 20) }, (_, i) => fxPost(i)), cursor: { top: null, bottom: 'fxnext' } }) : json({ code: 404, results: [], cursor: { top: null, bottom: null } })
    return json({ code: 404, message: 'NOT_FOUND' }, 404)
  }
  if (url.host === 'api.x.com' || url.host === 'x.com') {
    stats.x += 1
    await sleep(options.xMs)
    return json(xTimeline(20))
  }
  throw new Error(`benchmark received an unexpected fetch: ${url.href}`)
}) as typeof fetch

const { default: handler } = await import('../api/browse.ts')
const { resetMemoryCache } = await import('../lib/cache.ts')
const { resetPool } = await import('../lib/pool.ts')
const { resetSearchBreaker } = await import('../lib/browse.ts')

interface Outcome { status: number; headers: Record<string, string>; ms: number; redis: number; fx: number; x: number }

function invoke(query: Record<string, string>, ip: string): Promise<Outcome> {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'
  req.query = { ...query, via: 'route' }
  req.url = `/api/browse?${new URLSearchParams(req.query as Record<string, string>).toString()}`
  req.headers = { host: 'mdfromx.com', accept: 'text/markdown', 'x-real-ip': ip }
  const res = new ServerResponse(req) as VercelResponse
  const before = { ...stats }
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const finish = () => {
      const ms = performance.now() - started
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(res.getHeaders())) headers[key] = String(value)
      res.emit('finish')
      resolve({ status: res.statusCode, headers, ms, redis: stats.redis - before.redis, fx: stats.fx - before.fx, x: stats.x - before.x })
    }
    res.status = (code) => { res.statusCode = code; return res }
    res.send = () => { finish(); return res }
    res.end = (() => { finish(); return res }) as VercelResponse['end']
    handler(req, res).catch(reject)
  })
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0
}

interface Scenario {
  name: string
  /** Latency of the upstream call the request must make, subtracted to show x.md's own overhead. */
  upstreamMs: number
  expect: { status: number; cache: string; source?: string }
  prepare?: () => Promise<void>
  run: (n: number) => Promise<Outcome>
}

const breakerOpen = () => redis.strings.set('search:fxtwitter:breaker', { value: JSON.stringify({ until: Date.now() + 10 * 60_000, strikes: 3 }) })
/**
 * Two active API keys, as production has, so the pool snapshot reads real key
 * records and their counters. Their allowances stay well under the one-account
 * pool (40 per window) so the public share never reaches zero at the start of
 * a window, which would be a correct refusal rather than a measurement.
 */
const seedKeys = () => {
  for (const [id, label, limit] of [['k1aa', 'friend-one', 10], ['k2bb', 'friend-two', 5]] as const) {
    redis.exec(['SADD', 'apikeys:ids', id])
    redis.exec(['SET', `apikey:rec:${id}`, JSON.stringify({ id, label, limitPer15m: limit, disabled: false, createdAt: 1_790_000_000_000, hash: `hash-${id}` })])
    redis.exec(['SET', `apikey:last:${id}`, String(Date.now() - 60_000)])
  }
}
const freshStore = () => { redis = new FakeRedis(); seedKeys() }
/** The shared cache write after a miss is deferred past the response; a hit scenario must not start before it lands. */
const sharedWriteLanded = async () => {
  const deadline = Date.now() + 5_000
  while (![...redis.strings.keys()].some((key) => key.startsWith('cache:'))) {
    if (Date.now() > deadline) throw new Error('the warm-up request never wrote the shared cache')
    await sleep(5)
  }
}
const coldInstance = async () => { resetMemoryCache(); resetPool(); await resetSearchBreaker(true) }
const ip = (n: number) => `203.0.113.${(n % 200) + 1}`

const scenarios: Scenario[] = [
  {
    name: 'search miss, own-account provider, cold instance',
    upstreamMs: options.xMs,
    expect: { status: 200, cache: 'MISS', source: 'xsearch' },
    run: async (n) => { freshStore(); breakerOpen(); await coldInstance(); return invoke({ resource: 'search', q: `markdown bench ${n}` }, ip(n)) },
  },
  {
    name: 'search miss, own-account provider, warm instance',
    upstreamMs: options.xMs,
    expect: { status: 200, cache: 'MISS', source: 'xsearch' },
    prepare: async () => { freshStore(); breakerOpen(); await coldInstance(); await invoke({ resource: 'search', q: 'markdown warmup' }, ip(0)) },
    run: async (n) => { redis.clearCounters(); return invoke({ resource: 'search', q: `markdown warm ${n}` }, ip(n)) },
  },
  {
    name: 'search miss, FxTwitter up, cold instance',
    upstreamMs: options.fxMs,
    expect: { status: 200, cache: 'MISS', source: 'fxtwitter' },
    prepare: async () => { fxSearchUp = true },
    run: async (n) => { freshStore(); await coldInstance(); return invoke({ resource: 'search', q: `markdown fx ${n}` }, ip(n)) },
  },
  {
    name: 'search hit, shared cache, cold instance',
    upstreamMs: 0,
    expect: { status: 200, cache: 'HIT' },
    prepare: async () => { fxSearchUp = false; freshStore(); breakerOpen(); await coldInstance(); await invoke({ resource: 'search', q: 'markdown' }, ip(0)); await sharedWriteLanded() },
    run: async (n) => { redis.clearCounters(); resetMemoryCache(); return invoke({ resource: 'search', q: 'markdown' }, ip(n)) },
  },
  {
    name: 'followers miss, one upstream page, cold instance',
    upstreamMs: options.fxMs,
    expect: { status: 200, cache: 'MISS', source: 'fxtwitter' },
    run: async (n) => { freshStore(); await coldInstance(); return invoke({ resource: 'followers', handle: `bench${n}` }, ip(n)) },
  },
  {
    name: 'followers miss, slow upstream (3 of 5 pages slow), two bases',
    upstreamMs: options.fxMs,
    expect: { status: 200, cache: 'MISS', source: 'fxtwitter' },
    prepare: async () => { fxSlowPages = true; fxPages = 0 },
    run: async (n) => { freshStore(); await coldInstance(); return invoke({ resource: 'followers', handle: `slow${n}` }, ip(n)) },
  },
  {
    name: 'following hit, shared cache, cold instance',
    upstreamMs: 0,
    expect: { status: 200, cache: 'HIT' },
    prepare: async () => { fxSlowPages = false; freshStore(); await coldInstance(); await invoke({ resource: 'following', handle: 'jack' }, ip(0)); await sharedWriteLanded() },
    run: async (n) => { redis.clearCounters(); resetMemoryCache(); return invoke({ resource: 'following', handle: 'jack' }, ip(n)) },
  },
]

interface Row { scenario: string; runs: number; medianMs: number; p90Ms: number; overheadMedianMs: number; redisRoundTrips: number; upstreamCalls: number }
const rows: Row[] = []
for (const scenario of scenarios) {
  await scenario.prepare?.()
  const outcomes: Outcome[] = []
  for (let n = 1; n <= options.runs; n += 1) {
    const outcome = await scenario.run(n)
    const cache = outcome.headers['x-cache']
    const source = outcome.headers['x-source']
    if (outcome.status !== scenario.expect.status || cache !== scenario.expect.cache || (scenario.expect.source && source !== scenario.expect.source)) {
      throw new Error(`${scenario.name}: run ${n} answered ${outcome.status} cache=${cache} source=${source}, expected ${JSON.stringify(scenario.expect)}`)
    }
    outcomes.push(outcome)
  }
  const times = outcomes.map((o) => o.ms)
  const redisCounts = outcomes.map((o) => o.redis)
  rows.push({
    scenario: scenario.name,
    runs: outcomes.length,
    medianMs: percentile(times, 50),
    p90Ms: percentile(times, 90),
    overheadMedianMs: percentile(times, 50) - scenario.upstreamMs,
    redisRoundTrips: redisCounts.reduce((a, b) => a + b, 0) / redisCounts.length,
    upstreamCalls: outcomes.reduce((a, o) => a + o.fx + o.x, 0) / outcomes.length,
  })
}

const fmt = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))
console.log(`browse latency · runs=${options.runs} · store rtt=${options.redisMs} ms · own-account search=${options.xMs} ms · FxTwitter page=${options.fxMs} ms`)
console.log('')
console.log('| scenario | median ms | p90 ms | own overhead ms (median − upstream) | store round trips | upstream calls |')
console.log('|---|---:|---:|---:|---:|---:|')
for (const row of rows) console.log(`| ${row.scenario} | ${fmt(row.medianMs)} | ${fmt(row.p90Ms)} | ${fmt(row.overheadMedianMs)} | ${fmt(row.redisRoundTrips)} | ${fmt(row.upstreamCalls)} |`)
if (options.json) await writeFile(options.json, JSON.stringify({ options, rows }, null, 2))
process.exit(0)
