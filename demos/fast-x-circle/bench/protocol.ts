/**
 * Times Fast X Circle, then the original X Circle collector.
 * First progress is the first fetched post or mention. Complete includes
 * ranking and the portrait lookups the circle waits for.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { collectCircle, type CircleEvent } from '../src/engine'
import { ingestIncoming, ingestOwn, personFrom, rank, WINDOW_DAYS, type Interaction, type Person, type Tweet } from '../src/rank'

const FX = 'https://api.fxtwitter.com/2'
const OUT = new URL('../public/evidence/', import.meta.url)
const CANDIDATES = [
  'seldo', 'vboykis', 'jlongster', 'sarahdrasner', 'mbostock', 'mapbox', 'gaearon',
  'rich_harris', 'paul_irish', 'getify', 'jashkenas', 'csswizardry', 'sophiebits',
  'lexfridman', 'delba_oliveira', 'chriscoyier', 'sarah_edo', 'addyosmani',
]

interface Sample {
  system: 'x-circle' | 'fast-x-circle'
  handle: string
  firstProgressMs: number | null
  completeMs: number | null
  postsProcessed: number | null
  postsPerSec: number | null
  people: number | null
  mentionsRead: boolean
  error?: string
}

function authHeaders(): Headers {
  const key = process.env.X_MD_API_KEY
  if (!key) throw new Error('missing_key')
  return new Headers({ Authorization: `Bearer ${key}`, Accept: 'application/json' })
}

async function archiveCount(handle: string): Promise<number | null> {
  const response = await fetch(`https://mdfromx.com/api/v1/profiles/${encodeURIComponent(handle)}/posts?index=true`, { headers: authHeaders() })
  if (!response.ok) return -1
  const body = await response.json() as { archive?: { count?: number } | null }
  return body.archive?.count ?? null
}

async function fx(url: string, signal: AbortSignal): Promise<{ status: number; body: { results?: Tweet[]; cursor?: { bottom?: string }; user?: { screen_name?: string; name?: string; avatar_url?: string; protected?: boolean } } | null }> {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    headers: { Accept: 'application/json', 'User-Agent': 'fast-x-circle-bench' },
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body }
}

async function longerPage(url: string, signal: AbortSignal) {
  let best: { results?: Tweet[]; cursor?: { bottom?: string } } | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { status, body } = await fx(url, signal)
      if (status === 200 && body && ((body.results?.length ?? 0) >= (best?.results?.length ?? 0))) best = body
    } catch (error) {
      if (signal.aborted) throw error
    }
    if ((best?.results?.length ?? 0) >= 5) break
  }
  return best
}

async function walk(start: string, signal: AbortSignal, pages: number, cutoff: number, onPage: (posts: Tweet[]) => void): Promise<{ ok: boolean; oldest: number | null }> {
  let cursor = ''
  let oldest: number | null = null
  for (let index = 0; index < pages; index += 1) {
    const url = new URL(start)
    url.searchParams.set('count', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const body = await longerPage(url.toString(), signal)
    if (!body) return { ok: index !== 0, oldest }
    const results = (body.results ?? []).filter((post) => post.id && (post as Tweet & { type?: string }).type !== 'user')
    const kept = results.filter((post) => (post.created_timestamp ?? Number.POSITIVE_INFINITY) >= cutoff)
    onPage(kept)
    for (const post of kept) {
      const at = post.created_timestamp
      if (at && (oldest == null || at < oldest)) oldest = at
    }
    const bottom = body.cursor?.bottom?.trim() ?? ''
    const dropped = results.length - kept.length
    if (!bottom || bottom === cursor || results.length === 0 || dropped > Math.max(1, results.length / 2) || (kept.length === 0 && index > 0)) break
    cursor = bottom
  }
  return { ok: true, oldest }
}

async function portraits(members: Array<{ handle: string; avatar: string | null }>, signal: AbortSignal): Promise<void> {
  const queue = members.filter((member) => !member.avatar).slice(0, 50)
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const member = queue.shift()
      if (!member || signal.aborted) return
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { status, body } = await fx(`${FX}/profile/${encodeURIComponent(member.handle)}`, signal)
          if (status === 200 && body?.user) {
            member.avatar = personFrom(body.user)?.avatar ?? null
            break
          }
        } catch {
          if (signal.aborted) return
        }
      }
    }
  })
  await Promise.all(workers)
}

async function originalCircle(handle: string): Promise<Sample> {
  const started = performance.now()
  const signal = AbortSignal.timeout(140_000)
  const now = Date.now() / 1000
  const cutoff = now - WINDOW_DAYS * 86400
  let firstProgressMs: number | null = null
  const note = () => { if (firstProgressMs == null) firstProgressMs = performance.now() - started }
  const interactions: Interaction[] = []
  const seen = new Set<string>()
  let ownPosts = 0
  let mentions = 0
  const push = (interaction: Interaction) => {
    const key = `${interaction.tweetId}:${interaction.other.handle.toLowerCase()}:${interaction.kind}:${interaction.direction}`
    if (seen.has(key)) return
    seen.add(key)
    interactions.push(interaction)
  }
  const profile = await fx(`${FX}/profile/${encodeURIComponent(handle)}`, signal)
  if (profile.status === 404) return fail(handle, 'x-circle', 'not found')
  if (profile.body?.user?.protected) return fail(handle, 'x-circle', 'private')
  const statuses = new URL(`${FX}/profile/${encodeURIComponent(handle)}/statuses`)
  statuses.searchParams.set('with_replies', 'true')
  const search = new URL(`${FX}/search`)
  search.searchParams.set('q', `@${handle}`)
  search.searchParams.set('feed', 'latest')
  let mentionsRead = false
  const [own, incoming] = await Promise.all([
    walk(statuses.toString(), signal, 10, cutoff, (posts) => {
      for (const post of posts) ingestOwn(post, handle, cutoff, push)
      ownPosts += posts.length
      if (posts.length) note()
    }),
    walk(search.toString(), signal, 10, cutoff, (posts) => {
      for (const post of posts) if (ingestIncoming(post, handle, cutoff, push)) mentions += 1
      if (posts.length) note()
    }),
  ])
  mentionsRead = incoming.ok
  if (!own.ok && ownPosts === 0) return fail(handle, 'x-circle', 'timeline unavailable')
  const members = rank(interactions, now).slice(0, 50)
  if (ownPosts === 0) return fail(handle, 'x-circle', 'no recent posts')
  if (members.length === 0) return fail(handle, 'x-circle', 'nobody to draw')
  await portraits(members, signal)
  const completeMs = performance.now() - started
  const postsProcessed = ownPosts + mentions
  return { system: 'x-circle', handle, firstProgressMs, completeMs, postsProcessed, postsPerSec: postsProcessed / (completeMs / 1000), people: members.length, mentionsRead }
}

async function fastCircle(handle: string): Promise<Sample> {
  let done: Extract<CircleEvent, { type: 'done' }> | null = null
  let error: string | undefined
  try {
    await collectCircle(handle, {
      fresh: true,
      onEvent: (event) => { if (event.type === 'done') done = event },
    })
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'failed'
  }
  if (!done) return fail(handle, 'fast-x-circle', error ?? 'no result')
  const posts = done.snapshot.postsRead
  return {
    system: 'fast-x-circle',
    handle,
    firstProgressMs: done.timing.firstProgressMs,
    completeMs: done.timing.completeMs,
    postsProcessed: posts,
    postsPerSec: done.timing.postsPerSec,
    people: done.snapshot.members.length,
    mentionsRead: done.snapshot.mentionsRead,
    error: done.snapshot.members.length ? undefined : error,
  }
}

function fail(handle: string, system: Sample['system'], error: string): Sample {
  return { system, handle, firstProgressMs: null, completeMs: null, postsProcessed: null, postsPerSec: null, people: null, mentionsRead: false, error }
}

function seconds(ms: number | null): string {
  return ms == null ? '—' : `${(ms / 1000).toFixed(2)}s`
}

function rate(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(1)
}

function html(samples: Sample[], accounts: string[]): string {
  const rows = accounts.map((handle) => {
    const before = samples.find((sample) => sample.handle === handle && sample.system === 'x-circle')
    const after = samples.find((sample) => sample.handle === handle && sample.system === 'fast-x-circle')
    const speed = before?.completeMs && after?.completeMs ? before.completeMs / after.completeMs : null
    const first = before?.firstProgressMs && after?.firstProgressMs ? before.firstProgressMs / after.firstProgressMs : null
    return `<tr><td rowspan="2">@${handle}</td><td>X Circle</td><td>${seconds(before?.firstProgressMs ?? null)}</td><td>${seconds(before?.completeMs ?? null)}</td><td>${before?.postsProcessed ?? '—'}</td><td>${rate(before?.postsPerSec ?? null)}</td><td>${before?.people ?? '—'}</td></tr>
      <tr><td>Fast X Circle</td><td>${seconds(after?.firstProgressMs ?? null)}</td><td>${seconds(after?.completeMs ?? null)}</td><td>${after?.postsProcessed ?? '—'}</td><td>${rate(after?.postsPerSec ?? null)}</td><td>${after?.people ?? '—'}</td></tr>
      <tr class="sum"><td></td><td>Speedup</td><td colspan="5">first progress ${first ? `${first.toFixed(2)}×` : '—'} · complete circle ${speed ? `${speed.toFixed(2)}×` : '—'}</td></tr>`
  }).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Benchmark · Fast X Circle</title><link rel="stylesheet" href="/style.css" />
<style>
  table { width: 100%; border-collapse: collapse; margin-top: 28px; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--cn-rule); vertical-align: top; }
  th { font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--cn-ink-2); }
  tr.sum td { color: var(--cn-ink-2); font-weight: 700; }
  figure { margin: 28px 0; }
  figure img { width: min(560px, 100%); border-radius: 20px; background: var(--cn-navy); }
  pre { white-space: pre-wrap; background: white; border: 1px solid var(--cn-rule); border-radius: 16px; padding: 16px; }
</style></head><body>
<header class="top"><a class="brand" href="/">Fast X Circle</a><nav><a href="/">Circle</a><a href="/benchmark.html">Benchmark</a><a href="/report.html">Report</a></nav></header>
<main class="xc">
  <h1 class="xc-title">Before and after</h1>
  <p class="xc-lead">Three public accounts whose x.md archive was empty. Fast X Circle ran first, then X Circle’s own collector (ten pages of the account and ten pages of mentions), so the two do not compete for the same upstream. First progress is the first fetched post or mention. Complete is the ranked circle, including portrait lookups. Posts are own posts plus incoming mentions. Posts per second uses the complete time.</p>
  <table><thead><tr><th>Account</th><th></th><th>First progress</th><th>Complete circle</th><th>Posts</th><th>Posts/s</th><th>People</th></tr></thead><tbody>${rows}</tbody></table>
  <figure><img src="/evidence/circle-demo.png" alt="A finished Fast X Circle in the browser" /><figcaption>The same circle, drawn in the browser, with a PNG export.</figcaption></figure>
  <h2>Raw samples</h2>
  <pre>${JSON.stringify(samples, null, 2).replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]!))}</pre>
</main></body></html>`
}

const pool: string[] = []
for (const handle of CANDIDATES) {
  if ((await archiveCount(handle)) !== null) continue
  pool.push(handle)
  if (pool.length >= 6) break
}
if (pool.length < 3) throw new Error(`only found ${pool.length} uncached accounts`)
console.log('pool', pool.join(','))
await mkdir(OUT, { recursive: true })
const samples: Sample[] = []
const accounts: string[] = []
for (const handle of pool) {
  if (accounts.length >= 3) break
  if ((await archiveCount(handle)) !== null) {
    console.log('skip cached', handle)
    continue
  }
  console.log('measuring', handle)
  let after = await fastCircle(handle).catch((error: unknown) => fail(handle, 'fast-x-circle', error instanceof Error ? error.message : 'failed'))
  if (after.error === 'rate_limited') {
    console.log('search budget cooling down')
    await Bun.sleep(60_000)
    after = await fastCircle(handle).catch((error: unknown) => fail(handle, 'fast-x-circle', error instanceof Error ? error.message : 'failed'))
  }
  const before = await originalCircle(handle).catch((error: unknown) => fail(handle, 'x-circle', error instanceof Error ? error.message : 'failed'))
  samples.push(before, after)
  const usable = !before.error && !after.error && (before.postsProcessed ?? 0) > 0 && (after.postsProcessed ?? 0) > 0
  if (usable) accounts.push(handle)
  console.log(JSON.stringify({ before, after, usable }))
}
if (accounts.length < 3) throw new Error(`only measured ${accounts.length} accounts`)
const measuredAt = new Date().toISOString()
await writeFile(new URL('results.json', OUT), JSON.stringify({ measuredAt, accounts, samples: samples.filter((sample) => accounts.includes(sample.handle)) }, null, 2))
await writeFile(new URL('../benchmark.html', OUT), html(samples.filter((sample) => accounts.includes(sample.handle)), accounts))
console.log('wrote', accounts.join(','))
