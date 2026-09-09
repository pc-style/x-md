/**
 * Import throughput benchmark.
 *
 *   bun scripts/benchmark-import.ts [--accounts paulg,levelsio] [--target 600] [--reps 1] [--quick]
 *
 * For each account it picks a date range holding ~`target` posts, builds a
 * reference set (union of several walks), then times every strategy against it:
 * naive sequential, sequential with short-page retry, and the parallel forged
 * cursor walk across concurrency, window size, retry and replies settings.
 * Scores throughput (posts/s), upstream cost (requests per post), and
 * completeness against the reference. Every upstream request is counted by
 * wrapping `fetch`, and the whole run is paced under FxTwitter's ~1000 req/min
 * per IP so throttling does not pollute the numbers.
 *
 * Writes bench/results-<timestamp>.json and bench/RESULTS.md.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { cursorAt } from '../lib/fx-cursor.ts'
import { fetchFxProfileStatuses, type FxTweet } from '../lib/fxtwitter.ts'
import { estimateRate, importProfilePosts, isRepost, ownPost, postTime } from '../lib/import.ts'

// ---------------------------------------------------------------------------
// Upstream accounting and pacing
// ---------------------------------------------------------------------------

const RATE_CAP_PER_MIN = 840
const stamps: number[] = []
const counters = { requests: 0, status: {} as Record<string, number>, latencies: [] as number[], paced_ms: 0 }
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: any) => {
  for (;;) {
    const now = Date.now()
    while (stamps.length && stamps[0] < now - 60_000) stamps.shift()
    if (stamps.length < RATE_CAP_PER_MIN) break
    const wait = stamps[0] + 60_000 - now + 50
    counters.paced_ms += wait
    await new Promise((r) => setTimeout(r, wait))
  }
  stamps.push(Date.now())
  counters.requests += 1
  const started = performance.now()
  const response = await realFetch(input, init)
  counters.latencies.push(performance.now() - started)
  counters.status[response.status] = (counters.status[response.status] ?? 0) + 1
  return response
}) as typeof fetch

function snapshot() {
  return { requests: counters.requests, status: { ...counters.status }, latencies: counters.latencies.length, paced_ms: counters.paced_ms, latSum: counters.latencies.reduce((a, b) => a + b, 0) }
}
function delta(a: ReturnType<typeof snapshot>, b: ReturnType<typeof snapshot>) {
  const status: Record<string, number> = {}
  for (const k of new Set([...Object.keys(a.status), ...Object.keys(b.status)])) status[k] = (b.status[k] ?? 0) - (a.status[k] ?? 0)
  const n = b.latencies - a.latencies
  return { requests: b.requests - a.requests, status, avg_latency_ms: n ? Math.round((b.latSum - a.latSum) / n) : 0, paced_ms: b.paced_ms - a.paced_ms }
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

interface RunResult {
  strategy: string
  handle: string
  ok: boolean
  error?: string
  wall_ms: number
  posts: number
  originals: number
  replies: number
  reposts: number
  posts_per_s: number
  requests: number
  requests_per_100_posts: number
  retried_pages?: number
  http_429: number
  avg_latency_ms: number
  paced_ms: number
  windows?: number
  completeness?: number
  missing?: number
  extra?: number
  ids: string[]
}

type Strategy = { name: string; run: (handle: string, since: Date, until: Date, withReplies: boolean) => Promise<{ posts: FxTweet[]; retried?: number; windows?: number }> }

/** What a normal FxTwitter client does: follow `cursor.bottom` until the range is covered. */
function sequential(retries: number): Strategy {
  return {
    name: retries ? 'sequential + short-page retry' : 'sequential (naive)',
    async run(handle, since, until, withReplies) {
      const posts = new Map<string, FxTweet>()
      let cursor: string | undefined = cursorAt(until.getTime() + 1)
      let retried = 0
      for (let pages = 0; pages < 400; pages += 1) {
        const page = await fetchFxProfileStatuses(handle, cursor, 100, { withReplies, retries })
        retried += (page.attempts ?? 1) - 1
        if (page.results.length === 0) break
        // Same crossing rule as the engine: the page tail decides, entries are kept by their own time.
        const tail: number[] = []
        for (const post of page.results) {
          if (!ownPost(post, handle) || !post.id) continue
          if (isRepost(post)) { posts.set(post.id, post); continue }
          const at = postTime(post)
          tail.push(at); if (tail.length > 3) tail.shift()
          if (at >= since.getTime() && at <= until.getTime()) posts.set(post.id, post)
        }
        if ((tail.length && Math.max(...tail) < since.getTime()) || !page.cursor?.bottom) break
        cursor = page.cursor.bottom
      }
      return { posts: [...posts.values()], retried }
    },
  }
}

function parallel(name: string, concurrency: number, windowTargetPosts = 60, pageRetries = 2): Strategy {
  return {
    name,
    async run(handle, since, until, withReplies) {
      const result = await importProfilePosts({ handle, since, until, maxPosts: 5000, concurrency, withReplies, withReposts: true, tuning: { windowTargetPosts, pageRetries } })
      return { posts: result.posts, retried: result.meta.retried_pages, windows: result.meta.windows }
    },
  }
}

const STRATEGIES: Array<{ strategy: Strategy; withReplies: boolean; group: string }> = [
  { strategy: sequential(0), withReplies: true, group: 'baseline' },
  { strategy: sequential(2), withReplies: true, group: 'baseline' },
  { strategy: parallel('parallel c=4', 4), withReplies: true, group: 'concurrency' },
  { strategy: parallel('parallel c=8', 8), withReplies: true, group: 'concurrency' },
  { strategy: parallel('parallel c=16 (default)', 16), withReplies: true, group: 'concurrency' },
  { strategy: parallel('parallel c=24', 24), withReplies: true, group: 'concurrency' },
  { strategy: parallel('parallel c=32', 32), withReplies: true, group: 'concurrency' },
  { strategy: parallel('parallel c=16 window=30', 16, 30), withReplies: true, group: 'window' },
  { strategy: parallel('parallel c=16 window=120', 16, 120), withReplies: true, group: 'window' },
  { strategy: parallel('parallel c=16 window=240', 16, 240), withReplies: true, group: 'window' },
  { strategy: parallel('parallel c=16 no retry', 16, 60, 0), withReplies: true, group: 'retry' },
  { strategy: parallel('parallel c=16 originals only', 16), withReplies: false, group: 'replies' },
]

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Every repost id seen by any run, so completeness can ignore them. */
const repostIds = new Set<string>()

const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
const ACCOUNTS = opt('accounts', 'elonmusk,levelsio,paulg,ID_AA_Carmack').split(',')
const TARGET = Number(opt('target', '600'))
const REPS = Number(opt('reps', '1'))
const QUICK = args.includes('--quick')

const strategies = QUICK ? STRATEGIES.filter((s) => ['baseline', 'concurrency'].includes(s.group)) : STRATEGIES

function summarize(handle: string, posts: FxTweet[]) {
  const own = posts.filter((p) => ownPost(p, handle))
  const originals = own.filter((p) => !isRepost(p) && !(p.replying_to && (!Array.isArray(p.replying_to) || p.replying_to.length)))
  const reposts = own.filter(isRepost)
  return { originals: originals.length, reposts: reposts.length, replies: own.length - originals.length - reposts.length }
}

async function timed(strategy: Strategy, handle: string, since: Date, until: Date, withReplies: boolean): Promise<RunResult> {
  const before = snapshot()
  const t0 = performance.now()
  try {
    const out = await strategy.run(handle, since, until, withReplies)
    const wall = performance.now() - t0
    const d = delta(before, snapshot())
    const s = summarize(handle, out.posts)
    for (const post of out.posts) if (isRepost(post) && post.id) repostIds.add(post.id)
    return {
      strategy: strategy.name, handle, ok: true, wall_ms: Math.round(wall), posts: out.posts.length, ...s,
      posts_per_s: Math.round(out.posts.length / (wall / 1000)), requests: d.requests,
      requests_per_100_posts: out.posts.length ? Math.round((d.requests / out.posts.length) * 100) : 0,
      retried_pages: out.retried, http_429: d.status['429'] ?? 0, avg_latency_ms: d.avg_latency_ms, paced_ms: d.paced_ms, windows: out.windows,
      ids: out.posts.map((p) => p.id!),
    }
  } catch (error) {
    const d = delta(before, snapshot())
    return { strategy: strategy.name, handle, ok: false, error: String(error).slice(0, 200), wall_ms: Math.round(performance.now() - t0), posts: 0, originals: 0, replies: 0, reposts: 0, posts_per_s: 0, requests: d.requests, requests_per_100_posts: 0, http_429: d.status['429'] ?? 0, avg_latency_ms: d.avg_latency_ms, paced_ms: d.paced_ms, ids: [] }
  }
}

async function pickRange(handle: string): Promise<{ since: Date; until: Date; rate: number }> {
  const until = new Date()
  const first = await fetchFxProfileStatuses(handle, cursorAt(until.getTime() + 1), 100, { withReplies: true, retries: 2 })
  const rate = estimateRate(first.results, handle)
  const hours = Math.min(Math.max(TARGET / rate, 6), 24 * 400)
  return { since: new Date(until.getTime() - hours * 3_600_000), until, rate }
}

function pct(n: number) { return `${(n * 100).toFixed(1)}%` }

async function main() {
  await mkdir('bench', { recursive: true })
  const startedAt = new Date()
  const report: { accounts: Record<string, unknown>; runs: RunResult[] } = { accounts: {}, runs: [] }
  const lines: string[] = [`# Import throughput benchmark`, ``, `Run ${startedAt.toISOString()} against \`${process.env.FXTWITTER_BASE_URL ?? 'https://api.fxtwitter.com'}\` from one IP, paced under ${RATE_CAP_PER_MIN} req/min. Target ≈ ${TARGET} posts per account, replies and reposts included. Completeness is measured against the union of every run for that account (non-repost posts only: reposts at range edges are ambiguous by nature).`, ``]

  for (const handle of ACCOUNTS) {
    console.log(`\n== @${handle}`)
    const { since, until, rate } = await pickRange(handle)
    console.log(`   range ${since.toISOString()} → ${until.toISOString()} (est. ${rate.toFixed(2)} posts/h)`)
    const runs: RunResult[] = []
    for (let rep = 0; rep < REPS; rep += 1) {
      for (const { strategy, withReplies } of strategies) {
        const result = await timed(strategy, handle, since, until, withReplies)
        runs.push(result)
        console.log(`   ${result.ok ? 'ok ' : 'ERR'} ${strategy.name.padEnd(34)} ${String(result.posts).padStart(5)} posts ${String(result.wall_ms).padStart(6)} ms ${String(result.posts_per_s).padStart(4)}/s  req=${result.requests} 429=${result.http_429}${result.error ? '  ' + result.error : ''}`)
      }
    }
    // Reference: union of every successful run of the same kind, reposts excluded
    // (a repost's position at a range edge is ambiguous by nature).
    const score = (subset: RunResult[]) => {
      const ref = new Set<string>()
      for (const run of subset) for (const id of run.ids) if (!repostIds.has(id)) ref.add(id)
      for (const run of subset) {
        const ids = new Set(run.ids)
        run.missing = [...ref].filter((id) => !ids.has(id)).length
        run.extra = [...ids].filter((id) => !ref.has(id) && !repostIds.has(id)).length
        run.completeness = ref.size ? 1 - run.missing / ref.size : 1
      }
      return ref.size
    }
    const referenceSize = score(runs.filter((r) => r.ok && r.replies > 0))
    score(runs.filter((r) => r.ok && r.replies === 0))
    const reference = { size: referenceSize }
    report.accounts[handle] = { since, until, rate, reference: reference.size }
    report.runs.push(...runs)

    lines.push(`## @${handle}`, ``, `Range ${since.toISOString().slice(0, 16)} → ${until.toISOString().slice(0, 16)}, est. ${rate.toFixed(2)} posts/h, reference ${reference.size} posts.`, ``,
      `| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |`, `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|`)
    for (const r of runs) {
      lines.push(r.ok
        ? `| ${r.strategy} | ${r.posts} | ${r.replies} | ${r.reposts} | ${(r.wall_ms / 1000).toFixed(1)} s | **${r.posts_per_s}** | ${r.requests} | ${r.requests_per_100_posts} | ${r.retried_pages ?? '-'} | ${r.http_429} | ${pct(r.completeness ?? 0)} |`
        : `| ${r.strategy} | — | — | — | ${(r.wall_ms / 1000).toFixed(1)} s | 0 | ${r.requests} | — | — | ${r.http_429} | failed: ${r.error} |`)
    }
    lines.push(``)
  }

  // Winners: fastest strategy with ≥ 99% completeness, per account and overall.
  lines.push(`## Best performing`, ``)
  const byStrategy = new Map<string, RunResult[]>()
  for (const r of report.runs) if (r.ok && r.replies > 0) byStrategy.set(r.strategy, [...(byStrategy.get(r.strategy) ?? []), r])
  const ranked = [...byStrategy.entries()].map(([name, rs]) => ({
    name,
    posts_per_s: Math.round(rs.reduce((a, r) => a + r.posts_per_s, 0) / rs.length),
    completeness: rs.reduce((a, r) => a + (r.completeness ?? 0), 0) / rs.length,
    req_per_100: Math.round(rs.reduce((a, r) => a + r.requests_per_100_posts, 0) / rs.length),
    http_429: rs.reduce((a, r) => a + r.http_429, 0),
  })).sort((a, b) => b.posts_per_s - a.posts_per_s)
  lines.push(`| strategy (mean over accounts) | posts/s | completeness | req/100 posts | 429s |`, `|---|---:|---:|---:|---:|`)
  for (const r of ranked) lines.push(`| ${r.name} | **${r.posts_per_s}** | ${pct(r.completeness)} | ${r.req_per_100} | ${r.http_429} |`)
  const winner = ranked.find((r) => r.completeness >= 0.99 && r.http_429 === 0) ?? ranked[0]
  const baseline = ranked.find((r) => r.name.startsWith('sequential + short'))
  lines.push(``, `**Winner (fastest with ≥99% completeness and no throttling): ${winner.name} — ${winner.posts_per_s} posts/s${baseline ? `, ${(winner.posts_per_s / Math.max(1, baseline.posts_per_s)).toFixed(1)}× the sequential baseline (${baseline.posts_per_s} posts/s)` : ''}.**`, ``)
  lines.push(`Total upstream requests: ${counters.requests}; paced waits: ${(counters.paced_ms / 1000).toFixed(0)} s; wall: ${((Date.now() - startedAt.getTime()) / 1000).toFixed(0)} s.`)

  const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
  await writeFile(`bench/results-${stamp}.json`, JSON.stringify({ ...report, runs: report.runs.map(({ ids, ...rest }) => rest) }, null, 2))
  await writeFile('bench/RESULTS.md', lines.join('\n') + '\n')
  console.log(`\nwrote bench/RESULTS.md and bench/results-${stamp}.json`)
}

await main()
