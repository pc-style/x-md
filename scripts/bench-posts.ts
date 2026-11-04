/**
 * End-to-end latency benchmark for `GET /:handle/posts`.
 *
 *   bun scripts/bench-posts.ts --base /tmp/x-md-base [--handle paulg] [--runs 12]
 *     [--scenarios warm50,warm200,cold50,cold200] [--seed] [--rtt 25] [--mbps 20]
 *
 * Runs the real `api/import.ts` handler in-process against live FxTwitter, with
 * the shared Redis replaced by an in-memory Upstash REST fake that charges a
 * round-trip time and a transfer rate per pipeline call. The defaults are
 * calibrated from production (2026-10-13, fra1): a small archive read is ~27 ms
 * per round trip, and one read of a 3,581-post archive adds ~540 ms.
 *
 * `--base` points at a checkout of the code to compare against (for example
 * `git archive origin/main api lib | tar -x -C /tmp/x-md-base` plus a
 * `node_modules` symlink). Each iteration runs base and head back to back on
 * the same scenario, alternating which goes first, so both see the same
 * upstream conditions. Warm scenarios restore a seeded archive snapshot before
 * every run; cold scenarios start from an empty store.
 *
 * Upstream requests are paced under a per-minute cap and every run waits for
 * headroom first, so pacing never lands inside a measured request.
 *
 * `--sim` swaps the live upstream for a synthetic one serving the seeded
 * archive as the timeline, with the latency and short-page behaviour measured
 * live on 2026-10-13 (full pages lognormal around 1.6 s, a short answer in
 * ≥ 2.3 s with probability `--short` (default 0.3), the profile a spurious
 * NOT_FOUND after 2.5 s with probability `--profile-miss` (default 0.3)), so
 * variants can be compared without the upstream's mood swings.
 */
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeTimelineCursor } from '../lib/fx-cursor.ts'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i].replace(/^--/, '')
  const next = process.argv[i + 1]
  if (next === undefined || next.startsWith('--')) args.set(key, 'true')
  else { args.set(key, next); i += 1 }
}
const HANDLE = args.get('handle') ?? 'paulg'
const RUNS = Number(args.get('runs') ?? 12)
const RTT_MS = Number(args.get('rtt') ?? 25)
const BYTES_PER_MS = Number(args.get('mbps') ?? 20) * 1000
const SCENARIOS = (args.get('scenarios') ?? 'warm50,warm200,cold50').split(',')
const BASE = args.get('base')
const HEAD = fileURLToPath(new URL('..', import.meta.url))
const SNAPSHOT = args.get('snapshot') ?? `/tmp/bench-posts-${HANDLE}.json`
let UPSTREAM_CAP_PER_MIN = Number(args.get('cap') ?? 300)
const REDIS_URL = 'https://bench-redis.invalid'
const SIM = args.has('sim')
const SIM_SHORT = Number(args.get('short') ?? 0.3)
const SIM_PROFILE_MISS = Number(args.get('profile-miss') ?? 0.3)

process.env.KV_REST_API_URL = REDIS_URL
process.env.KV_REST_API_TOKEN = 'bench'
delete process.env.UPSTASH_REDIS_REST_URL

// ---------------------------------------------------------------------------
// Fake Upstash REST
// ---------------------------------------------------------------------------

type Value = { kind: 'string'; value: string } | { kind: 'hash'; value: Map<string, string> } | { kind: 'zset'; value: Map<string, number> }
let db = new Map<string, Value>()
const redisStats = { calls: 0, bytes: 0 }

function hash(key: string) {
  let entry = db.get(key)
  if (!entry) db.set(key, (entry = { kind: 'hash', value: new Map() }))
  if (entry.kind !== 'hash') throw new Error('WRONGTYPE')
  return entry.value
}
function zset(key: string) {
  let entry = db.get(key)
  if (!entry) db.set(key, (entry = { kind: 'zset', value: new Map() }))
  if (entry.kind !== 'zset') throw new Error('WRONGTYPE')
  return entry.value
}
const str = (key: string) => { const e = db.get(key); return e?.kind === 'string' ? e.value : null }
const bound = (raw: string | number, fallback: number) => raw === '-inf' ? -Infinity : raw === '+inf' ? Infinity : Number(raw ?? fallback)

function zrangeByScoreRev(key: string, max: number, min: number, offset = 0, count = Infinity, withScores = false): string[] {
  const z = db.get(key)
  if (!z || z.kind !== 'zset') return []
  // Redis orders equal scores by member, reversed under REV.
  const sorted = [...z.value].filter(([, s]) => s >= min && s <= max).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
  const page = sorted.slice(offset, count === Infinity ? undefined : offset + count)
  return withScores ? page.flatMap(([m, s]) => [m, String(s)]) : page.map(([m]) => m)
}

function run(command: (string | number)[]): unknown {
  const [name, ...rest] = command
  const a = rest.map(String)
  switch (String(name).toUpperCase()) {
    case 'INCR': { const v = Number(str(a[0]) ?? 0) + 1; db.set(a[0], { kind: 'string', value: String(v) }); return v }
    case 'DECR': { const v = Number(str(a[0]) ?? 0) - 1; db.set(a[0], { kind: 'string', value: String(v) }); return v }
    case 'EXPIRE': case 'PEXPIRE': return db.has(a[0]) ? 1 : 0
    case 'GET': return str(a[0])
    case 'MGET': return a.map(str)
    case 'SET': {
      if (a.slice(2).map((x) => x.toUpperCase()).includes('NX') && db.has(a[0])) return null
      db.set(a[0], { kind: 'string', value: a[1] }); return 'OK'
    }
    case 'DEL': { let n = 0; for (const k of a) if (db.delete(k)) n += 1; return n }
    case 'HGETALL': { const e = db.get(a[0]); return e?.kind === 'hash' ? [...e.value].flat() : [] }
    case 'HSET': { const h = hash(a[0]); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n += 1; h.set(a[i], a[i + 1]) } return n }
    case 'HMGET': { const e = db.get(a[0]); return a.slice(1).map((f) => (e?.kind === 'hash' ? e.value.get(f) ?? null : null)) }
    case 'ZADD': { const z = zset(a[0]); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!z.has(a[i + 1])) n += 1; z.set(a[i + 1], Number(a[i])) } return n }
    case 'ZCARD': { const e = db.get(a[0]); return e?.kind === 'zset' ? e.value.size : 0 }
    case 'ZREM': { const e = db.get(a[0]); let n = 0; if (e?.kind === 'zset') for (const m of a.slice(1)) if (e.value.delete(m)) n += 1; return n }
    case 'ZREMRANGEBYSCORE': { const e = db.get(a[0]); if (e?.kind !== 'zset') return 0; let n = 0; for (const [m, s] of e.value) if (s >= bound(a[1], -Infinity) && s <= bound(a[2], Infinity)) { e.value.delete(m); n += 1 } return n }
    case 'ZRANGE': {
      const flags = a.slice(3).map((x) => x.toUpperCase())
      if (!flags.includes('BYSCORE') || !flags.includes('REV')) throw new Error(`unsupported ZRANGE ${a.join(' ')}`)
      const limit = flags.indexOf('LIMIT')
      return zrangeByScoreRev(a[0], bound(a[1], Infinity), bound(a[2], -Infinity), limit >= 0 ? Number(a[3 + limit + 1]) : 0, limit >= 0 ? Number(a[3 + limit + 2]) : Infinity, flags.includes('WITHSCORES'))
    }
    case 'EVAL': {
      const script = a[0]
      if (script.includes('ZREMRANGEBYSCORE')) {
        // Import admission: KEYS[1], ARGV now, expiry, max, id, lease.
        const [, , key, now, expiry, max, id] = a
        const z = zset(key)
        for (const [m, s] of z) if (s <= Number(now)) z.delete(m)
        if (z.size >= Number(max)) return 0
        z.set(id, Number(expiry)); return 1
      }
      if (script.includes("redis.call('GET'")) {
        const [, , key, token] = a
        if (str(key) === token) { db.delete(key); return 1 }
        return 0
      }
      throw new Error('unsupported EVAL')
    }
    default: throw new Error(`unsupported command ${String(name)}`)
  }
}

async function fakeRedis(body: string): Promise<Response> {
  const commands = JSON.parse(body) as (string | number)[][]
  const replies = commands.map((command) => { try { return { result: run(command) } } catch (error) { return { error: error instanceof Error ? error.message : 'ERR' } } })
  const out = JSON.stringify(replies)
  redisStats.calls += 1
  redisStats.bytes += body.length + out.length
  await new Promise((r) => setTimeout(r, RTT_MS + (body.length + out.length) / BYTES_PER_MS))
  return new Response(out, { headers: { 'Content-Type': 'application/json' } })
}

// ---------------------------------------------------------------------------
// Simulated upstream
// ---------------------------------------------------------------------------

const TWEPOCH = 1288834974657n
let simTimeline: Array<{ sort: bigint; post: Record<string, unknown> }> = []
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gaussian = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function sortIndex(cursor: string): bigint {
  const b = Buffer.from(cursor.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  // Field 7 struct → field 1 i64 (11 bytes) → field 2 string: length at offset 17, text at 21.
  const length = b.readUInt32BE(17)
  return BigInt(b.subarray(21, 21 + length).toString('utf8'))
}

async function simFetch(url: string): Promise<Response> {
  if (!url.includes('/statuses?')) {
    if (Math.random() < SIM_PROFILE_MISS) { await sleepMs(2500); return json({ code: 404, message: 'User not found' }, 404) }
    await sleepMs(Math.exp(Math.log(1200) + 0.4 * gaussian()))
    return json({ code: 200, user: { screen_name: HANDLE, name: HANDLE, joined: 'Mon Oct 01 00:00:00 +0000 2007', statuses: simTimeline.length } })
  }
  if (Math.random() < SIM_SHORT) { await sleepMs(2300 + 300 * Math.random()); return json({ code: 200, results: [], cursor: {} }) }
  await sleepMs(Math.exp(Math.log(1600) + 0.4 * gaussian()))
  const cursor = new URL(url).searchParams.get('cursor')
  const below = cursor ? sortIndex(cursor) : 1n << 62n
  const start = simTimeline.findIndex((entry) => entry.sort < below)
  if (start < 0) return json({ code: 200, results: [], cursor: {} })
  const page = simTimeline.slice(start, start + 24)
  const last = page[page.length - 1].sort
  return json({ code: 200, results: page.map((entry) => entry.post), cursor: { bottom: encodeTimelineCursor({ issuedAt: 0n, sortIndex: last, direction: 2 }) } })
}

function loadSimTimeline(snapshot: Dump) {
  const posts = snapshot.find(([k]) => k === `hist:${HANDLE}:posts`)?.[1].value as Array<[string, string]> | undefined
  // Position by the post's own id: the archive keeps a repost under its original, so it sits where that original did.
  simTimeline = (posts ?? []).map(([id, raw]) => ({ sort: BigInt(id), post: JSON.parse(raw) as Record<string, unknown> })).sort((a, b) => (b.sort > a.sort ? 1 : -1))
  // Shift the timeline so its newest post is ten minutes old, as on a live account.
  const newest = simTimeline[0]?.sort ?? 0n
  const shift = ((BigInt(Date.now() - 600_000) - TWEPOCH) << 22n) - (newest & ~((1n << 22n) - 1n))
  for (const entry of simTimeline) {
    entry.sort += shift
    const ms = Number((entry.sort >> 22n) + TWEPOCH)
    entry.post = { ...entry.post, id: entry.sort.toString(), created_at: new Date(ms).toUTCString(), created_timestamp: Math.floor(ms / 1000) }
  }
}

// ---------------------------------------------------------------------------
// Upstream accounting and pacing
// ---------------------------------------------------------------------------

const stamps: number[] = []
/** `--trace file`: one JSON line per upstream request of a measured run. */
const trace: string[] = []
let label = ''
let runStarted = 0
const upstream = { requests: 0, latencies: [] as number[], short: [] as number[], full: [] as number[] }
const realFetch = globalThis.fetch
function headroom(): number {
  const now = Date.now()
  while (stamps.length && stamps[0] < now - 60_000) stamps.shift()
  return UPSTREAM_CAP_PER_MIN - stamps.length
}
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (new URL(url).origin === REDIS_URL) return fakeRedis(String(init?.body ?? ''))
  if (!SIM) while (headroom() <= 0) await new Promise((r) => setTimeout(r, 250))
  stamps.push(Date.now())
  upstream.requests += 1
  const started = performance.now()
  const response = SIM ? await simFetch(url) : await realFetch(input, init)
  const elapsed = performance.now() - started
  upstream.latencies.push(elapsed)
  let items: number | undefined
  if (url.includes('/statuses?')) {
    items = ((await response.clone().json().catch(() => ({}))) as { results?: unknown[] }).results?.length ?? 0
    ;(items < 8 ? upstream.short : upstream.full).push(elapsed)
  }
  // Where a page starts, as an ISO time, so a trace can be grouped by page.
  const cursor = url.includes('/statuses?') ? new URL(url).searchParams.get('cursor') : null
  const at = cursor ? new Date(Number((sortIndex(cursor) >> 22n) + TWEPOCH)).toISOString() : undefined
  if (label) trace.push(JSON.stringify({ run: label, kind: url.includes('/statuses?') ? 'page' : 'profile', at, start: Math.round(started - runStarted), ms: Math.round(elapsed), status: response.status, items }))
  return response
}) as typeof fetch

// ---------------------------------------------------------------------------
// Handler driver
// ---------------------------------------------------------------------------

type Handler = (req: unknown, res: unknown) => unknown
interface Outcome { ms: number; status: number; ids: string[]; posts: Array<{ id?: string; created_at?: string; reposted_by?: unknown }>; meta?: Record<string, unknown>; upstream: number; redisCalls: number; redisBytes: number }

async function call(handler: Handler, query: Record<string, string>): Promise<Outcome> {
  const req = new IncomingMessage(new Socket()) as IncomingMessage & { query: Record<string, string> }
  req.method = 'GET'
  req.url = `/${HANDLE}/posts`
  req.query = { handle: HANDLE, ...query }
  req.headers = { host: 'mdfromx.com', accept: 'application/json', 'x-forwarded-for': '203.0.113.7' }
  const res = new ServerResponse(req) as unknown as ServerResponse & { status: (code: number) => unknown; send: (body: unknown) => unknown }
  const before = { up: upstream.requests, calls: redisStats.calls, bytes: redisStats.bytes }
  const started = performance.now()
  const body = await new Promise<string>((done) => {
    res.status = (code: number) => { res.statusCode = code; return res }
    res.send = (value: unknown) => { done(String(value)); return res }
    res.end = (() => { done(''); return res }) as typeof res.end
    void handler(req, res)
  })
  const ms = performance.now() - started
  res.emit('close')
  let parsed: { posts?: Outcome['posts']; meta?: Record<string, unknown> } = {}
  try { parsed = JSON.parse(body) } catch { /* problem bodies are JSON too; empty on HEAD */ }
  return { ms, status: res.statusCode, ids: (parsed.posts ?? []).map((p) => p.id ?? ''), posts: parsed.posts ?? [], meta: parsed.meta, upstream: upstream.requests - before.up, redisCalls: redisStats.calls - before.calls, redisBytes: redisStats.bytes - before.bytes }
}

async function load(root: string) {
  const mod = await import(`${root}/api/import.ts`) as { default: Handler }
  return mod.default
}

// ---------------------------------------------------------------------------
// Snapshot of a seeded archive
// ---------------------------------------------------------------------------

type Dump = Array<[string, { kind: string; value: unknown }]>
function dump(): Dump {
  return [...db].filter(([k]) => k.startsWith('hist:')).map(([k, v]) => [k, { kind: v.kind, value: v.kind === 'string' ? v.value : [...(v.value as Map<string, unknown>)] }])
}
function restore(snapshot: Dump | undefined) {
  db = new Map()
  for (const [k, v] of snapshot ?? []) db.set(k, v.kind === 'string' ? { kind: 'string', value: v.value as string } : { kind: v.kind as 'hash', value: new Map(v.value as Array<[string, string]>) } as Value)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitForHeadroom(need: number) {
  while (headroom() < need) await sleep(500)
}

const quantile = (values: number[], q: number) => {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]
}

async function main() {
  const head = await load(HEAD)
  const base = BASE ? await load(resolve(BASE)) : undefined

  if (args.has('seed') || !existsSync(SNAPSHOT)) {
    // A full walk can outlast the route's time budget on a slow upstream day, so seed through the library.
    console.error(`seeding ${HANDLE} archive (full walk)…`)
    restore(undefined)
    const { importWithHistory } = await import(`${HEAD}/lib/history.ts`) as typeof import('../lib/history.ts')
    const started = performance.now()
    // The walk self-limits (~200 requests/min at today's latency); pacing would only trip its per-request timeout.
    const cap = UPSTREAM_CAP_PER_MIN
    UPSTREAM_CAP_PER_MIN = 900
    const seeded = await importWithHistory({ handle: HANDLE, maxPosts: 5000 }).catch(() => importWithHistory({ handle: HANDLE, maxPosts: 5000 }))
    UPSTREAM_CAP_PER_MIN = cap
    console.error(`seeded ${seeded.posts.length} posts in ${Math.round(performance.now() - started)} ms, pages ${seeded.meta.pages}, warnings ${seeded.meta.warnings ?? 'none'}`)
    // Production's archive is complete but has not reached the floor; keep the backfill branch live.
    const index = hash(`hist:${HANDLE}:index`)
    index.set('incomplete', '0')
    index.set('floor_reached', '0')
    index.set('covered_since', index.get('oldest') ?? '')
    await writeFile(SNAPSHOT, JSON.stringify(dump()))
  }
  const snapshot = JSON.parse(await readFile(SNAPSHOT, 'utf8')) as Dump
  if (SIM) {
    // The archive is rebuilt from the synthetic timeline so its ids and coverage agree with it.
    loadSimTimeline(snapshot)
    restore(undefined)
    const { importWithHistory } = await import(`${HEAD}/lib/history.ts`) as typeof import('../lib/history.ts')
    const seeded = await importWithHistory({ handle: HANDLE, maxPosts: 5000 })
    console.error(`sim timeline ${simTimeline.length} entries; seeded ${seeded.posts.length} posts, pages ${seeded.meta.pages}`)
    const index = hash(`hist:${HANDLE}:index`)
    index.set('incomplete', '0')
    index.set('floor_reached', '0')
    index.set('covered_since', index.get('oldest') ?? '')
  } else {
    restore(snapshot)
  }
  // Bring the snapshot up to date so every top-up walks the same few hours.
  const caughtUp = await call(head, { limit: '50' })
  const fresh = dump()
  console.error(`snapshot: ${zset(`hist:${HANDLE}:ids`).size} posts, top-up walked ${JSON.stringify((caughtUp.meta?.archive as { walked?: unknown })?.walked)}`)
  // A top-up only runs once the archive is a minute old, as in production.
  await sleep(61_000)

  const results: Record<string, Record<string, Outcome[]>> = {}
  const variants: Array<[string, Handler]> = base ? [['base', base], ['head', head]] : [['head', head]]
  for (const scenario of SCENARIOS) {
    const warm = scenario.startsWith('warm')
    const limit = scenario.replace(/^\D+/, '')
    results[scenario] = Object.fromEntries(variants.map(([name]) => [name, []]))
    for (let i = 0; i < RUNS; i += 1) {
      const order = i % 2 === 0 ? variants : [...variants].reverse()
      const ids: Record<string, string[]> = {}
      const byVariant: Record<string, Outcome> = {}
      for (const [name, handler] of order) {
        await waitForHeadroom(warm ? 20 : 80)
        restore(warm ? fresh : undefined)
        label = `${scenario}#${i}:${name}`
        runStarted = performance.now()
        const outcome = await call(handler, { limit })
        label = ''
        results[scenario][name].push(outcome)
        ids[name] = outcome.ids
        const m = outcome.meta ?? {}
        console.error(`${scenario} #${i} ${name}: ${Math.round(outcome.ms)} ms status=${outcome.status} posts=${outcome.ids.length} upstream=${outcome.upstream} pages=${m.pages} windows=${m.windows} redis=${outcome.redisCalls}/${Math.round(outcome.redisBytes / 1024)}KB walked=${JSON.stringify((m.archive as { walked?: unknown })?.walked)}${m.warnings ? ` warnings=${JSON.stringify(m.warnings)}` : ''}`)
        byVariant[name] = outcome
        await sleep(1500)
      }
      if (ids.base && ids.head) {
        const a = new Set(ids.base)
        const missing = ids.head.filter((id) => !a.has(id)).length + ids.base.filter((id) => !new Set(ids.head).has(id)).length
        if (missing) {
          console.error(`  selections differ by ${missing} ids`)
          const describe = (o: Outcome, other: Set<string>) => o.posts.filter((p) => !other.has(p.id ?? '')).map((p) => `${p.id}@${new Date(p.created_at ?? 0).toISOString().slice(0, 16)}${p.reposted_by ? ':rt' : ''}`).join(' ')
          console.error(`    only base: ${describe(byVariant.base, new Set(ids.head))}`)
          console.error(`    only head: ${describe(byVariant.head, new Set(ids.base))}`)
        }
      }
    }
  }

  const lines = ['| scenario | variant | runs | median ms | p90 ms | mean ms | upstream req/run | redis calls/run | redis KB/run | same posts as base |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|']
  for (const [scenario, byVariant] of Object.entries(results)) {
    for (const [name, outcomes] of Object.entries(byVariant)) {
      const ms = outcomes.map((o) => o.ms)
      const same = name === 'head' && byVariant.base
        ? `${outcomes.filter((o, i) => o.ids.join() === byVariant.base[i].ids.join()).length}/${outcomes.length}`
        : '—'
      const avg = (f: (o: Outcome) => number) => (outcomes.reduce((s, o) => s + f(o), 0) / outcomes.length)
      lines.push(`| ${scenario} | ${name} | ${outcomes.length} | ${Math.round(quantile(ms, 0.5))} | ${Math.round(quantile(ms, 0.9))} | ${Math.round(avg((o) => o.ms))} | ${avg((o) => o.upstream).toFixed(1)} | ${avg((o) => o.redisCalls).toFixed(1)} | ${Math.round(avg((o) => o.redisBytes) / 1024)} | ${same} |`)
    }
  }
  const lat = upstream.latencies
  lines.push('', `Upstream: ${upstream.requests} requests, latency median ${Math.round(quantile(lat, 0.5))} ms, p90 ${Math.round(quantile(lat, 0.9))} ms; timeline pages ${upstream.full.length} full (median ${Math.round(quantile(upstream.full, 0.5))} ms), ${upstream.short.length} short (median ${Math.round(quantile(upstream.short, 0.5))} ms). Fake Redis: ${RTT_MS} ms RTT, ${BYTES_PER_MS / 1000} MB/s.`)
  console.log(lines.join('\n'))
  if (args.has('trace')) await writeFile(args.get('trace')!, trace.join('\n') + '\n')
  // `--ids file`: every run's selection, to score each against the union of all runs.
  if (args.has('ids')) await writeFile(args.get('ids')!, JSON.stringify(Object.fromEntries(Object.entries(results).map(([scenario, byVariant]) => [scenario, Object.fromEntries(Object.entries(byVariant).map(([name, outcomes]) => [name, outcomes.map((o) => o.status === 200 ? o.posts.map((p) => ({ id: p.id, at: p.created_at, rt: Boolean(p.reposted_by) })) : null)]))]))))
  if (args.has('json')) await writeFile(args.get('json')!, JSON.stringify(results, (k, v) => (k === 'ids' ? v.length : v)))
  process.exit(0)
}

await main()
