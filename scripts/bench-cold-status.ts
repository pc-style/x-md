/**
 * bun scripts/bench-cold-status.ts --runs 9 --out bench/cold-status-before.json
 *
 * Each conversion starts with an empty application cache, uses the real
 * converter and upstreams, and keeps the default full thread + top replies.
 * No Redis or disk cache is used. Upstream caches cannot be cleared here.
 * Module imports are outside the timer: cold runtime startup is another slice.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const args = process.argv.slice(2)
const option = (name: string) => args[args.indexOf(name) + 1]
const runs = args.includes('--runs') ? Number(option('--runs')) : 9
if (!Number.isInteger(runs) || runs < 3 || runs > 100) throw new Error('--runs must be 3–100')
const out = args.includes('--out') ? option('--out') : undefined
const cases = [
  { handle: 'jack', id: '20', kind: 'baseline' },
  { handle: 'trq212', id: '2052809885763747935', kind: 'article' },
  { handle: 'nthglsn', id: '2087920734702022870', kind: 'photos' },
  { handle: 'hams', id: '2089985826394357796', kind: 'parent chain' },
  { handle: 'josevc', id: '2088260915770585422', kind: 'quote' },
  { handle: 'matthew_d_green', id: '2097693527450816692', kind: 'author thread' },
].filter(target => !args.includes('--cases') || option('--cases').split(',').includes(target.id))

process.env.CACHE_PERSIST = '0'
delete process.env.CACHE_DISABLED
for (const name of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
  delete process.env[name]
}

const { convertTweet } = await import('../lib/converter.ts')
const { resetMemoryCache } = await import('../lib/cache.ts')
interface RequestTiming {
  provider: string
  path: string
  startMs: number
  durationMs: number
  status?: number
  error?: string
}
interface Sample {
  handle: string
  id: string
  kind: string
  ms: number
  cache?: string
  source?: string
  posts?: number
  error?: string
  requests: RequestTiming[]
}
const samples: Sample[] = []
const actualFetch = globalThis.fetch
let started = 0
let requests: RequestTiming[] = []
// Measure through JSON consumption rather than only until response headers.
globalThis.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
  const url = new URL(String(args[0]))
  const at = performance.now()
  const timing: RequestTiming = {
    provider: url.hostname, path: url.pathname,
    startMs: at - started, durationMs: 0,
  }
  requests.push(timing)
  try {
    const response = await actualFetch(...args)
    timing.status = response.status
    timing.durationMs = performance.now() - at
    const json = response.json.bind(response)
    response.json = async () => {
      try { return await json() } finally { timing.durationMs = performance.now() - at }
    }
    return response
  } catch (error) {
    timing.durationMs = performance.now() - at
    timing.error = error instanceof Error ? error.name : 'unknown'
    throw error
  }
}, actualFetch)

try {
  for (let run = 0; run < runs; run++) {
    for (const target of cases) {
      resetMemoryCache()
      requests = []
      started = performance.now()
      let sample: Sample
      try {
        const result = await convertTweet(target)
        if (result.cache !== 'miss') throw new Error(`Expected cold MISS, got ${result.cache}`)
        sample = { ...target, ms: performance.now() - started, cache: result.cache,
          source: result.source, posts: result.postCount, requests }
      } catch (error) {
        sample = { ...target, ms: performance.now() - started, requests,
          error: error instanceof Error && 'code' in error ? String(error.code) : 'conversion_failed' }
      }
      samples.push(sample)
      console.log(JSON.stringify({ run: run + 1, ...sample }))
      await delay(750)
    }
  }
} finally {
  globalThis.fetch = actualFetch
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  if (!sorted.length) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
}
const summarize = (selected: Sample[]) => {
  const successful = selected.filter(s => !s.error)
  return { runs: selected.length, successes: successful.length,
    medianMs: percentile(successful.map(s => s.ms), 0.5),
    p90Ms: percentile(successful.map(s => s.ms), 0.9) }
}
const report = {
  measuredAt: new Date().toISOString(),
  method: 'Bun, real convertTweet, empty memory cache per run, disk/Redis disabled; upstream caches uncontrolled; default thread/context/replies',
  summary: summarize(samples),
  cases: cases.map(target => ({ ...target, ...summarize(samples.filter(s => s.id === target.id)) })),
  samples,
}
console.log(JSON.stringify(report, null, 2))
if (out) {
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`)
}
if (samples.some(s => s.error)) process.exitCode = 1
