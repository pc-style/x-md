/**
 * Live benchmark of the X fetcher prototypes against production x.md: latency,
 * success, completeness measured against production's own output, and how each
 * target behaves under a short burst.
 *
 *   bun bench/fetchers/bench.ts run   [--target name=url ...] [--only a,b] [--out run.json]
 *   bun bench/fetchers/bench.ts burst [--target name=url ...] [--only a,b] [--requests 32] [--concurrency 4] [--out burst.json]
 *   bun bench/fetchers/bench.ts report --run run.json [--burst burst.json] --html out/index.html
 *
 * Every target gets the same posts and handles from `fixtures.json`.
 *
 * `run` fetches each item twice back to back, so the second fetch shows the
 * target's cached path (the GraphQL prototype keeps answers for 60 s). One item
 * at a time per target; the targets run side by side, since they are different
 * hosts.
 *
 * `burst` sends distinct uncached requests (all posts, then profiles with
 * varying page sizes, which defeats the GraphQL prototype's cache key) with low
 * concurrency, and records statuses, 429s and Retry-After. Run it at least 15
 * minutes after `run` so the GraphQL prototype's per-IP window (30 uncached
 * requests per 15 minutes) starts fresh and the burst measures its limit, not
 * the leftovers of `run`.
 *
 * A target is either prototype-shaped (`GET /post/:id`, `GET /user/:handle`) or,
 * with an `xmd:` prefix on its URL, the x.md v1 API. Add another prototype with
 * `--target guest=https://...`; every response is normalised by shape, not by
 * target name, so an fx-shaped JSON body needs no new code.
 *
 * Raw bodies are never written out: results hold statuses, timings and the
 * normalised fields the completeness checks compare.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

type Target = { name: string; base: string; api: 'proto' | 'xmd' }

const DEFAULT_TARGETS: Target[] = [
  { name: 'production', base: 'https://mdfromx.com', api: 'xmd' },
  { name: 'graphql-session', base: 'https://x-graphql-proto-portal.pcstyle.dev', api: 'proto' },
  { name: 'syndication', base: 'https://x-md-syndication-portal.pcstyle.dev', api: 'proto' },
  { name: 'fx-selfhost', base: 'https://xmd-fx-proto-portal.pcstyle.dev', api: 'proto' },
]
const BASELINE = 'production'
const TIMEOUT_MS = 30_000

const argv = process.argv.slice(2)
const command = argv[0]
const opt = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const opts = (name: string): string[] => argv.flatMap((value, index) => (argv[index - 1] === `--${name}` ? [value] : []))

function targets(): Target[] {
  const list = [...DEFAULT_TARGETS]
  for (const spec of opts('target')) {
    const at = spec.indexOf('=')
    if (at < 1) throw new Error(`--target wants name=url, got ${spec}`)
    const name = spec.slice(0, at)
    let base = spec.slice(at + 1)
    const api = base.startsWith('xmd:') ? 'xmd' : 'proto'
    base = base.replace(/^xmd:/, '').replace(/\/+$/, '')
    const existing = list.findIndex((t) => t.name === name)
    if (existing >= 0) list[existing] = { name, base, api }
    else list.push({ name, base, api })
  }
  const only = opt('only')?.split(',')
  return only ? list.filter((t) => only.includes(t.name)) : list
}

type Fixtures = {
  posts: { id: string; kind: string; note: string }[]
  handles: { handle: string; kind: string }[]
}
const fixtures: Fixtures = JSON.parse(await readFile(join(here, 'fixtures.json'), 'utf8'))

// --- URLs ------------------------------------------------------------------

function postUrl(t: Target, id: string, fresh: boolean): string {
  if (t.api === 'xmd') {
    const q = new URLSearchParams({ url: `https://x.com/i/status/${id}`, format: 'json', thread: 'full', replies: 'off', full: '1' })
    if (fresh) q.set('nocache', '1')
    return `${t.base}/api/v1/posts?${q}`
  }
  return `${t.base}/post/${id}?thread=full&replies=off`
}

function userUrl(t: Target, handle: string, fresh: boolean, count = 20): string {
  if (t.api === 'xmd') {
    const q = new URLSearchParams({ format: 'json', limit: String(count), full: '1' })
    if (fresh) q.set('nocache', '1')
    return `${t.base}/api/v1/profiles/${handle}?${q}`
  }
  // `count` for the GraphQL and fx prototypes, `limit` for syndication.
  return `${t.base}/user/${handle}?count=${count}&limit=${count}`
}

// --- Normalising -----------------------------------------------------------

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export type NPost = {
  id: string
  text: string
  author?: string
  photos: number
  videos: number
  quoteId?: string
  replyTo?: string
  likes?: number
  authorFollowers?: number
  created?: boolean
  context?: string
}

function normPost(raw: unknown): NPost {
  const p = obj(raw)
  const media = obj(p.media)
  const quote = obj(p.quote)
  const author = obj(p.author)
  return {
    id: String(p.id ?? ''),
    text: str(p.text) ?? str(obj(p.raw_text).text) ?? '',
    author: str(author.screen_name),
    photos: arr(media.photos).length,
    // Syndication files GIFs under `animated`; the fx shape lists them as videos.
    videos: arr(media.videos).length + arr(media.animated).length,
    quoteId: str(quote.id),
    replyTo: str(p.replying_to_status) ?? str(obj(p.replying_to).status) ?? str(p.in_reply_to_status_id),
    likes: num(p.likes),
    authorFollowers: num(author.followers),
    created: Boolean(p.created_at || p.created_timestamp),
    context: str(p.context),
  }
}

/** Posts from any of the shapes seen: x.md and fx `posts`, syndication `tweets`, GraphQL `thread`/`status`. */
function postList(body: Json): unknown[] {
  for (const key of ['posts', 'tweets', 'thread']) if (arr(body[key]).length) return arr(body[key])
  return body.status ? [body.status] : []
}

export type NPostResult = { focal?: NPost; chain: string[] }

function normPostBody(body: Json, id: string): NPostResult {
  const posts = postList(body).map(normPost)
  const focal = posts.find((p) => p.id === id) ?? posts.find((p) => p.context === 'post')
  // The author chain around the post: parents and the author's own continuation, not replies.
  const chain = posts.filter((p) => p.id !== focal?.id && p.context !== 'reply').map((p) => p.id)
  return { focal, chain }
}

export type NProfile = {
  found: boolean
  protected?: boolean
  name?: string
  description: boolean
  followers?: number
  statuses?: number
  avatar: boolean
  banner: boolean
  joined: boolean
  posts: string[]
  degraded?: boolean
}

function normUserBody(body: Json): NProfile {
  const u = obj(body.profile ?? body.user)
  return {
    found: Boolean(u.screen_name || u.id),
    protected: typeof u.protected === 'boolean' ? u.protected : undefined,
    name: str(u.name),
    description: typeof u.description === 'string',
    followers: num(u.followers),
    statuses: num(u.statuses),
    avatar: Boolean(u.avatar_url),
    banner: Boolean(u.banner_url),
    joined: Boolean(u.joined || u.created_at),
    posts: arr(body.posts)
      .map(obj)
      .filter((p) => !p.reposted_by)
      .map((p) => String(p.id ?? '')),
    degraded: typeof body.degraded === 'boolean' ? body.degraded : undefined,
  }
}

// --- Fetching --------------------------------------------------------------

export type Sample = {
  target: string
  kind: 'post' | 'user'
  key: string
  pass: 'cold' | 'warm' | 'burst' | 'baseline'
  /** Taken from a later `--extra` run because this run's answer was the harness's own 429 or a production failure. */
  retried?: boolean
  at: string
  status: number
  ms: number
  serverMs?: number
  cache?: string
  upstreamCalls?: number
  upstreamFailures?: number
  errorCode?: string
  retryAfter?: string
  post?: NPostResult
  profile?: NProfile
}

async function fetchOne(t: Target, kind: 'post' | 'user', key: string, url: string, pass: Sample['pass']): Promise<Sample> {
  const at = new Date().toISOString()
  const started = performance.now()
  let status = 0
  let body: Json = {}
  let headers = new Headers()
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'x-md-fetcher-bench/1' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    status = response.status
    headers = response.headers
    const text = await response.text()
    try {
      body = obj(JSON.parse(text))
    } catch {
      body = {}
    }
  } catch (error) {
    body = { error: { code: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network' } }
  }
  const ms = Math.round(performance.now() - started)
  const timing = obj(body.timing)
  const calls = arr(timing.upstream).length ? arr(timing.upstream) : arr(timing.steps)
  const failures = calls.filter((c) => {
    const call = obj(c)
    return call.ok === false || (typeof call.status === 'number' && call.status >= 400)
  }).length
  const error = obj(body.error)
  const sample: Sample = {
    target: t.name,
    kind,
    key,
    pass,
    at,
    status,
    ms,
    serverMs: num(timing.total_ms),
    cache: str(timing.cache) ?? str(body.cache) ?? headers.get('x-cache')?.toLowerCase() ?? undefined,
    upstreamCalls: calls.length || undefined,
    upstreamFailures: calls.length ? failures : undefined,
    errorCode: str(error.code) ?? str(body.code) ?? (typeof body.error === 'string' ? body.error.slice(0, 60) : undefined),
    retryAfter: headers.get('retry-after') ?? undefined,
  }
  if (status >= 200 && status < 300) {
    if (kind === 'post') sample.post = normPostBody(body, key)
    else sample.profile = normUserBody(body)
  }
  return sample
}

async function pool<T>(items: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const out: T[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        out[index] = await items[index]()
      }
    }),
  )
  return out
}

/** `--keys post:20,user:jack` limits `run` to those items, for retrying a few after a rate-limit window. */
const keys = opt('keys')?.split(',')
const wanted = (kind: string, key: string) => !keys || keys.includes(`${kind}:${key}`)

async function runPasses(list: Target[]): Promise<Sample[]> {
  const perTarget = await Promise.all(
    list.map(async (t) => {
      const samples: Sample[] = []
      const log = (s: Sample) => console.log(`${t.name.padEnd(16)} ${s.pass} ${s.kind} ${s.key.padEnd(20)} ${s.status} ${s.ms}ms${s.cache ? ` ${s.cache}` : ''}`)
      for (const { id } of fixtures.posts.filter((p) => wanted('post', p.id))) {
        for (const pass of ['cold', 'warm'] as const) {
          const s = await fetchOne(t, 'post', id, postUrl(t, id, pass === 'cold'), pass)
          samples.push(s)
          log(s)
        }
      }
      for (const { handle } of fixtures.handles.filter((h) => wanted('user', h.handle))) {
        for (const pass of ['cold', 'warm'] as const) {
          const s = await fetchOne(t, 'user', handle, userUrl(t, handle, pass === 'cold'), pass)
          samples.push(s)
          log(s)
        }
      }
      return samples
    }),
  )
  return perTarget.flat()
}

async function runBurst(list: Target[], requests: number, concurrency: number): Promise<Sample[]> {
  const perTarget = await Promise.all(
    list.map(async (t) => {
      const jobs: (() => Promise<Sample>)[] = []
      const profiles = fixtures.handles.filter((h) => h.kind === 'profile')
      for (let i = 0; i < requests; i++) {
        if (i < fixtures.posts.length) {
          const id = fixtures.posts[i].id
          jobs.push(() => fetchOne(t, 'post', id, postUrl(t, id, true), 'burst'))
        } else {
          const n = i - fixtures.posts.length
          const handle = profiles[n % profiles.length].handle
          // A page size no other request used keeps the GraphQL prototype's cache out of it.
          const count = 19 - Math.floor(n / profiles.length)
          jobs.push(() => fetchOne(t, 'user', `${handle}?count=${count}`, userUrl(t, handle, true, count), 'burst'))
        }
      }
      const started = performance.now()
      const samples = await pool(jobs, concurrency)
      console.log(`${t.name.padEnd(16)} burst ${samples.length} requests in ${Math.round(performance.now() - started)}ms: ${JSON.stringify(countBy(samples.map((s) => String(s.status))))}`)
      return samples
    }),
  )
  return perTarget.flat()
}

// --- Scoring ---------------------------------------------------------------

const countBy = (values: string[]): Record<string, number> =>
  values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {})

export function pct(values: number[], p: number): number | undefined {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

const normText = (text: string) =>
  text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)

export type Check = { name: string; ok: boolean; detail?: string }

/** What the fixture says the right answer is, so a production failure on a deleted post cannot make "found" look wrong. */
function expected(kind: 'post' | 'user', key: string): 'found' | 'absent' | 'protected' {
  const fixture = kind === 'post' ? fixtures.posts.find((p) => p.id === key) : fixtures.handles.find((h) => h.handle === key.split('?')[0])
  if (fixture?.kind === 'deleted' || fixture?.kind === 'missing') return 'absent'
  return fixture?.kind === 'protected' ? 'protected' : 'found'
}

const cleanNotFound = (s?: Sample) => Boolean(s && s.status >= 400 && s.status < 500 && s.status !== 429)
const failed = (s?: Sample) => `status ${s?.status || 'timeout'}${s?.errorCode ? ` ${s.errorCode}` : ''}`

/** Checks a target's post against production's; with no usable production answer only "found" is scored. */
export function comparePost(target: Sample | undefined, base: Sample | undefined, key: string): Check[] {
  const t = target?.post?.focal
  const b = base?.post?.focal
  if (expected('post', key) === 'absent') return [{ name: 'clean not found', ok: !t && cleanNotFound(target), detail: t ? 'returned a post' : failed(target) }]
  if (!t) return [{ name: 'found', ok: false, detail: failed(target) }]
  if (!b) return [{ name: 'found', ok: true, detail: 'production failed, nothing to compare' }]
  const checks: Check[] = [{ name: 'found', ok: true }]
  checks.push({ name: 'text', ok: normText(t.text) === normText(b.text) || normText(t.text).startsWith(normText(b.text).slice(0, 60)) })
  if (b.photos || t.photos) checks.push({ name: 'photos', ok: t.photos === b.photos, detail: `${t.photos}/${b.photos}` })
  if (b.videos || t.videos) checks.push({ name: 'video', ok: t.videos === b.videos, detail: `${t.videos}/${b.videos}` })
  if (b.quoteId) checks.push({ name: 'quote', ok: t.quoteId === b.quoteId })
  const baseChain = base!.post!.chain
  if (baseChain.length) {
    const got = baseChain.filter((id) => target!.post!.chain.includes(id)).length
    checks.push({ name: 'thread', ok: got === baseChain.length, detail: `${got}/${baseChain.length}` })
  }
  checks.push({ name: 'metrics', ok: t.likes !== undefined })
  checks.push({ name: 'author profile', ok: t.authorFollowers !== undefined })
  return checks
}

export function compareProfile(target: Sample | undefined, base: Sample | undefined, key: string): Check[] {
  const t = target?.profile
  const b = base?.profile
  const want = expected('user', key)
  if (want === 'absent') return [{ name: 'clean not found', ok: !t?.found && cleanNotFound(target), detail: t?.found ? 'returned a profile' : failed(target) }]
  // X still shows a protected account's header to everyone; only its posts are hidden.
  if (want === 'protected') return [{ name: 'protected profile', ok: Boolean(t?.found && t.protected), detail: t?.found ? `protected=${t.protected}` : failed(target) }]
  if (!t?.found) return [{ name: 'found', ok: false, detail: failed(target) }]
  if (!b?.found) return [{ name: 'found', ok: true, detail: 'production failed, nothing to compare' }]
  const checks: Check[] = [
    { name: 'found', ok: true },
    { name: 'protected flag', ok: t.protected === b.protected },
    { name: 'counts', ok: t.followers !== undefined && t.statuses !== undefined },
    { name: 'bio', ok: t.description === b.description },
    { name: 'images', ok: t.avatar === b.avatar && t.banner === b.banner },
    { name: 'joined', ok: t.joined === b.joined },
  ]
  if (b.posts.length) {
    const top = b.posts.slice(0, 10)
    const got = top.filter((id) => t.posts.includes(id)).length
    checks.push({ name: 'recent posts', ok: got >= Math.ceil(top.length * 0.8), detail: `${got}/${top.length}` })
  }
  return checks
}

// --- Report ----------------------------------------------------------------

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const fmtMs = (v?: number) => (v === undefined ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`)
const fmtPct = (v: number) => `${Math.round(v * 100)}%`

type RunFile = { started: string; finished: string; targets: Target[]; samples: Sample[] }

/** Success is the right answer for the fixture: the item, a clean 4xx for a deleted or missing one, or a protected header. */
function successOf(s: Sample): boolean {
  const want = expected(s.kind, s.key)
  if (want === 'absent') return !(s.post?.focal || s.profile?.found) && cleanNotFound(s)
  if (want === 'protected') return Boolean(s.profile?.found && s.profile.protected)
  return s.kind === 'post' ? Boolean(s.post?.focal) : Boolean(s.profile?.found)
}

/** Production's answer for an item: the uncached one, or its repeat when the first attempt failed. */
function baselines(run: RunFile): Map<string, Sample> {
  const map = new Map<string, Sample>()
  for (const s of run.samples.filter((x) => x.target === BASELINE)) {
    const key = `${s.kind}:${s.key}`
    const has = s.post?.focal || s.profile?.found
    if (!map.has(key) || (has && !(map.get(key)!.post?.focal || map.get(key)!.profile?.found))) map.set(key, s)
  }
  return map
}

/**
 * Folds a later retry run into the main one: a prototype's 429 (the harness spending its budget, not a fault) is
 * replaced by the retry's answer, and a production failure gains the retry as its baseline without changing
 * production's own success figures.
 */
function mergeRetries(run: RunFile, extra: RunFile): RunFile {
  const samples = [...run.samples]
  for (const s of extra.samples) {
    const index = samples.findIndex((x) => x.target === s.target && x.kind === s.kind && x.key === s.key && x.pass === s.pass)
    if (s.target === BASELINE) {
      if (s.post?.focal || s.profile?.found) samples.push({ ...s, pass: 'baseline', retried: true })
    } else if (index >= 0 && samples[index].status === 429) {
      samples[index] = { ...s, retried: true }
    }
  }
  return { ...run, samples }
}

function summarise(run: RunFile, burst?: RunFile) {
  const baseCold = baselines(run)
  return run.targets.map((t) => {
    const cold = run.samples.filter((s) => s.target === t.name && s.pass === 'cold')
    const warm = run.samples.filter((s) => s.target === t.name && s.pass === 'warm')
    const ok = cold.filter(successOf)
    const okMs = (kind: string) => cold.filter((s) => s.kind === kind && s.status >= 200 && s.status < 300).map((s) => s.ms)
    const checks = (kind: 'post' | 'user') =>
      cold
        .filter((s) => s.kind === kind)
        .flatMap((s) => (kind === 'post' ? comparePost(s, baseCold.get(`post:${s.key}`), s.key) : compareProfile(s, baseCold.get(`user:${s.key}`), s.key)))
    const score = (list: Check[]) => (list.length ? list.filter((c) => c.ok).length / list.length : 0)
    const b = burst?.samples.filter((s) => s.target === t.name) ?? []
    const first429 = b.findIndex((s) => s.status === 429)
    return {
      target: t,
      success: ok.length / Math.max(1, cold.length),
      successCount: `${ok.length}/${cold.length}`,
      postP50: pct(okMs('post'), 50),
      postP95: pct(okMs('post'), 95),
      userP50: pct(okMs('user'), 50),
      userP95: pct(okMs('user'), 95),
      warmP50: pct(warm.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms), 50),
      postScore: t.name === BASELINE ? 1 : score(checks('post')),
      userScore: t.name === BASELINE ? 1 : score(checks('user')),
      cold429: cold.filter((s) => s.status === 429).length + warm.filter((s) => s.status === 429).length,
      burst: b.length
        ? {
            n: b.length,
            statuses: countBy(b.map((s) => String(s.status))),
            n429: b.filter((s) => s.status === 429).length,
            first429: first429 >= 0 ? first429 + 1 : undefined,
            retryAfter: b.find((s) => s.retryAfter)?.retryAfter,
            p50: pct(b.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms), 50),
            p95: pct(b.filter((s) => s.status >= 200 && s.status < 300).map((s) => s.ms), 95),
            upstreamFailures: b.reduce((n, s) => n + (s.upstreamFailures ?? 0), 0),
          }
        : undefined,
    }
  })
}

function renderReport(run: RunFile, burst: RunFile | undefined, notes: string | undefined): string {
  const rows = summarise(run, burst)
  const baseCold = baselines(run)
  const protos = run.targets.filter((t) => t.name !== BASELINE)
  const maxMs = Math.max(...rows.flatMap((r) => [r.postP95 ?? 0, r.userP95 ?? 0]), 1)
  const bar = (p50?: number, p95?: number) =>
    p50 === undefined
      ? '<span class="dim">no successful sample</span>'
      : `<span class="bar"><span class="p95" style="width:${(((p95 ?? p50) / maxMs) * 100).toFixed(1)}%"></span><span class="p50" style="width:${((p50 / maxMs) * 100).toFixed(1)}%"></span></span><span class="num">${fmtMs(p50)} · ${fmtMs(p95)}</span>`

  const summaryTable = `<table><thead><tr><th>Target</th><th>Success</th><th>Post p50 · p95</th><th>Profile p50 · p95</th><th>Repeat p50</th><th>Post completeness</th><th>Profile completeness</th><th>Burst (2xx / 429)</th></tr></thead><tbody>
${rows
  .map(
    (r) => `<tr><th>${esc(r.target.name)}${r.target.name === BASELINE ? ' <span class="tag">baseline</span>' : ''}<div class="dim small">${esc(r.target.base.replace(/^https:\/\//, ''))}</div></th>
<td>${fmtPct(r.success)} <span class="dim">(${r.successCount})</span></td><td>${bar(r.postP50, r.postP95)}</td><td>${bar(r.userP50, r.userP95)}</td><td>${fmtMs(r.warmP50)}</td>
<td>${r.target.name === BASELINE ? '<span class="dim">reference</span>' : fmtPct(r.postScore)}</td><td>${r.target.name === BASELINE ? '<span class="dim">reference</span>' : fmtPct(r.userScore)}</td>
<td>${r.burst ? `${Object.entries(r.burst.statuses).filter(([k]) => k.startsWith('2')).reduce((n, [, v]) => n + v, 0)} / ${r.burst.n429}<span class="dim"> of ${r.burst.n}</span>` : '–'}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`

  const cell = (checks: Check[]) => {
    if (!checks.length) return '<td class="dim">–</td>'
    const bad = checks.filter((c) => !c.ok)
    const title = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('\n')
    const label = bad.length ? bad.map((c) => `${c.name}${c.detail ? ` ${c.detail}` : ''}`).join(', ') : checks.length === 1 ? checks[0].name : 'all'
    return `<td class="${bad.length ? (checks[0].ok ? 'part' : 'fail') : 'pass'}" title="${esc(title)}">${esc(label)}</td>`
  }
  const sampleFor = (t: Target, kind: string, key: string) => run.samples.find((s) => s.target === t.name && s.pass === 'cold' && s.kind === kind && s.key === key)
  const baseLabel = (s?: Sample) => {
    if (!s) return '–'
    if (s.kind === 'post') {
      const f = s.post?.focal
      if (!f) return `${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}`
      const bits = [f.photos && `${f.photos} photo`, f.videos && `${f.videos} video`, f.quoteId && 'quote', s.post!.chain.length && `${s.post!.chain.length} in thread`].filter(Boolean)
      return bits.join(', ') || 'text'
    }
    const p = s.profile
    if (!p?.found) return `${s.status}${s.errorCode ? ` ${s.errorCode}` : ''}`
    return `${p.protected ? 'protected, ' : ''}${p.posts.length} posts`
  }
  const matrix = (kind: 'post' | 'user') => {
    const items = kind === 'post' ? fixtures.posts.map((p) => ({ key: p.id, kind: p.kind, note: p.note })) : fixtures.handles.map((h) => ({ key: h.handle, kind: h.kind, note: '' }))
    return `<table class="matrix"><thead><tr><th>${kind === 'post' ? 'Post' : 'Handle'}</th><th>Kind</th><th>Production returned</th>${protos.map((t) => `<th>${esc(t.name)}</th>`).join('')}</tr></thead><tbody>
${items
  .map((item) => {
    const base = baseCold.get(`${kind}:${item.key}`)
    return `<tr><th><code>${esc(item.key)}</code>${item.note ? `<div class="dim small">${esc(item.note)}</div>` : ''}</th><td>${esc(item.kind)}</td><td class="dim">${esc(baseLabel(base))} · ${fmtMs(base?.ms)}${base?.retried ? '<div class="small">first attempt failed; this is the retry</div>' : ''}</td>${protos
      .map((t) => {
        const s = sampleFor(t, kind, item.key)
        const checks = kind === 'post' ? comparePost(s, base, item.key) : compareProfile(s, base, item.key)
        return cell(checks).replace('</td>', `<div class="small dim">${s ? `${s.status} · ${fmtMs(s.ms)}${s.retried ? ' · retried after the 429 window' : ''}` : ''}</div></td>`)
      })
      .join('')}</tr>`
  })
  .join('\n')}
</tbody></table>`
  }

  const burstTable = burst
    ? `<table><thead><tr><th>Target</th><th>Requests</th><th>Statuses</th><th>First 429 at</th><th>Retry-After</th><th>2xx p50 · p95 under load</th><th>Upstream retries seen</th></tr></thead><tbody>
${rows
  .filter((r) => r.burst)
  .map(
    (r) => `<tr><th>${esc(r.target.name)}</th><td>${r.burst!.n}</td><td>${Object.entries(r.burst!.statuses)
      .map(([k, v]) => `<code>${k === '0' ? 'timeout' : k}</code>×${v}`)
      .join(' ')}</td><td>${r.burst!.first429 ? `request ${r.burst!.first429}` : '<span class="dim">none</span>'}</td><td>${r.burst!.retryAfter ? `${esc(r.burst!.retryAfter)} s` : '–'}</td><td>${fmtMs(r.burst!.p50)} · ${fmtMs(r.burst!.p95)}</td><td>${r.burst!.upstreamFailures || '<span class="dim">0</span>'}</td></tr>`,
  )
  .join('\n')}
</tbody></table><p class="dim small">Burst run ${esc(burst.started)} → ${esc(burst.finished)}. ${opt('burst-note') ?? ''}</p>`
    : '<p class="dim">No burst run in this report.</p>'

  const coldErrors = run.targets
    .map((t) => {
      const errs = run.samples.filter((s) => s.target === t.name && s.pass === 'cold' && (s.status < 200 || s.status >= 300))
      return errs.length ? `<li><b>${esc(t.name)}</b>: ${errs.map((s) => `${esc(s.kind)} <code>${esc(s.key)}</code> → ${s.status || 'timeout'}${s.errorCode ? ` ${esc(s.errorCode)}` : ''}`).join('; ')}</li>` : ''
    })
    .join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X fetcher prototypes vs production — bench ${esc(run.started.slice(0, 10))}</title>
<style>
:root{--bg:#0b0d0c;--panel:#131715;--line:#26302b;--ink:#e8ece9;--dim:#8d9a93;--good:#3fbf7f;--part:#d9a441;--bad:#e06464;--p50:#5aa9e6;--p95:#2c4e6b}
@media (prefers-color-scheme:light){:root{--bg:#f7f6f2;--panel:#fff;--line:#e2e0d8;--ink:#1b1f1d;--dim:#6b736e;--p95:#bcd6ec}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:1280px;margin:0 auto;padding:32px 20px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:36px 0 10px}
.dim{color:var(--dim)}.small{font-size:12px}.tag{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 7px;color:var(--dim);font-weight:500}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}thead th{font-size:12px;color:var(--dim);font-weight:600}
tbody th{font-weight:600}code{font:12px ui-monospace,monospace}
.bar{position:relative;display:inline-block;width:110px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle;margin-right:8px;overflow:hidden}
.bar span{position:absolute;left:0;top:0;bottom:0;border-radius:4px}.p95{background:var(--p95)}.p50{background:var(--p50)}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.matrix td{font-size:12px}.pass{box-shadow:inset 3px 0 var(--good)}.part{box-shadow:inset 3px 0 var(--part)}.fail{box-shadow:inset 3px 0 var(--bad)}
.key span{display:inline-block;margin-right:14px}.key i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
ul{padding-left:18px}li{margin:4px 0}.wrap{overflow-x:auto}
</style></head><body><main>
<h1>X fetcher prototypes vs production</h1>
<p class="dim">Run ${esc(run.started)} → ${esc(run.finished)} UTC, from one VM in Europe. Same ${fixtures.posts.length} posts and ${fixtures.handles.length} handles for every target, one request at a time per target. Harness: <code>bench/fetchers/bench.ts</code> on branch <code>bench/fetcher-prototypes</code>.</p>

<h2>Summary</h2>
<div class="wrap">${summaryTable}</div>
<p class="dim small">Latency is wall time from the client over successful (2xx) uncached requests; bars run to the slowest p95 on the page, blue is p50, pale is p95. Production was asked with <code>nocache=1</code>, <code>thread=full</code>, <code>replies=off</code>. "Success" means the right answer for the fixture: the item; a clean 4xx for the deleted and never-existing posts and the missing handle; the profile header with its protected flag for @emma. Completeness is the share of per-item checks that match production's own output (found, text, photo and video counts, quoted post, thread chain, metrics, author profile; for profiles: protected flag, counts, bio, images, join date, and at least 8 of production's 10 newest posts). "Repeat" is the immediate second request for the same item without <code>nocache</code>; production does not store a <code>nocache</code> answer, so its repeat is usually a miss too.</p>

<h2>Posts, per fixture</h2>
<p class="key small dim"><span><i style="background:var(--good)"></i>every check matches production</span><span><i style="background:var(--part)"></i>found, some fields differ (listed)</span><span><i style="background:var(--bad)"></i>wrong answer or failure</span> Hover a cell for every check.</p>
<div class="wrap">${matrix('post')}</div>

<h2>Profiles, per handle</h2>
<div class="wrap">${matrix('user')}</div>

<h2>Short burst</h2>
<p class="dim small">Distinct uncached requests, ${esc(opt('burst-shape') ?? 'concurrency 4')}: the ${fixtures.posts.length} posts, then profiles with page sizes no earlier request used so caches cannot answer.</p>
<div class="wrap">${burstTable}</div>

<h2>Non-2xx answers in the main run</h2>
<ul class="small">${coldErrors || '<li class="dim">none</li>'}</ul>
${notes ? `<h2>Notes</h2><div class="small">${notes}</div>` : ''}
</main></body></html>`
}

// --- Main ------------------------------------------------------------------

if (command === 'run' || command === 'burst') {
  const list = targets()
  if (!list.length) throw new Error('No targets selected.')
  const started = new Date().toISOString()
  const samples =
    command === 'run' ? await runPasses(list) : await runBurst(list, Number(opt('requests') ?? 32), Number(opt('concurrency') ?? 4))
  const out = opt('out') ?? join(here, 'results', `${command}-${started.replace(/[:.]/g, '-')}.json`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, JSON.stringify({ started, finished: new Date().toISOString(), targets: list, samples } satisfies RunFile, null, 1))
  console.log(`wrote ${out}`)
} else if (command === 'report') {
  const runPath = opt('run')
  if (!runPath) throw new Error('report needs --run <run.json>')
  let run: RunFile = JSON.parse(await readFile(runPath, 'utf8'))
  for (const extra of opts('extra')) run = mergeRetries(run, JSON.parse(await readFile(extra, 'utf8')))
  const burstPath = opt('burst')
  const burst: RunFile | undefined = burstPath ? JSON.parse(await readFile(burstPath, 'utf8')) : undefined
  const html = opt('html') ?? join(here, 'results', 'index.html')
  await mkdir(dirname(html), { recursive: true })
  const notes = opt('notes') ? await readFile(opt('notes')!, 'utf8') : undefined
  await writeFile(html, renderReport(run, burst, notes))
  for (const r of summarise(run, burst)) {
    console.log(
      [r.target.name, fmtPct(r.success), `post ${fmtMs(r.postP50)}/${fmtMs(r.postP95)}`, `user ${fmtMs(r.userP50)}/${fmtMs(r.userP95)}`, `repeat ${fmtMs(r.warmP50)}`, `complete post ${fmtPct(r.postScore)} user ${fmtPct(r.userScore)}`, r.burst ? `burst ${JSON.stringify(r.burst.statuses)}` : ''].join(' | '),
    )
  }
  console.log(`wrote ${html}`)
} else {
  console.log('usage: bun bench/fetchers/bench.ts run|burst|report [options]; see the header comment')
  process.exit(1)
}
