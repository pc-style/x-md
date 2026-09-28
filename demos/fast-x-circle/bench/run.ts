/**
 * Browser timings for X Circle and Fast X Circle on accounts whose x.md
 * archive is empty. Both tabs start together so neither one warms the
 * timeline for the other.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import puppeteer, { type Page } from 'puppeteer-core'

const CHROME = process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome'
const OURS = process.env.CIRCLE_URL ?? 'http://127.0.0.1:8787'
const ORIGINAL = 'https://cut-noodle.com/x-circle'
const OUT = new URL('../public/evidence/', import.meta.url)

const CANDIDATES = [
  'b0rk', 'steveruizok', 'tannerlinsley', 'dan_abramov', 'kentcdodds', 'cassidoo', 'wesbos', 'thdxr',
  'sarah_edo', 'una', 'addyosmani', 'sophiebits', 'ryanflorence', 'patrickc', 'gdb', 'lexfridman',
  'sarahdrasner', 'jlongster', 'rachelandrew', 'chriscoyier', 'adamwathan', 'mbostock', 'joshwcomeau',
  'leeerob', 'delba_oliveira', 'shuding_', 'seldo', 'mapbox', 'vboykis', 'cassidoo',
]

interface Sample {
  system: 'x-circle' | 'fast-x-circle'
  handle: string
  firstProgressMs: number | null
  completeMs: number | null
  postsProcessed: number | null
  postsPerSec: number | null
  people: number | null
  basis: string
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

async function pickAccounts(): Promise<string[]> {
  const open: string[] = []
  for (const handle of [...new Set(CANDIDATES)]) {
    const count = await archiveCount(handle)
    if (count !== null) continue
    open.push(handle)
    if (open.length >= 6) break
  }
  if (open.length < 3) throw new Error(`only found ${open.length} uncached public accounts`)
  return open
}

async function arm(page: Page): Promise<void> {
  await page.evaluate(() => {
    const marks = { t0: 0, first: null as number | null, done: null as number | null, posts: 0, mentions: 0, people: 0, basis: '', error: '' }
    ;(window as unknown as { __marks: typeof marks }).__marks = marks
    const read = () => {
      const em = document.querySelector('.scan-steps em')
      const fromData = em?.getAttribute('data-live-posts')
      const posts = Number(fromData ?? em?.textContent?.match(/(\d+)\s+post/)?.[1] ?? 0)
      const mentions = Number(em?.getAttribute('data-live-mentions') ?? em?.textContent?.match(/(\d+)\s+repl/)?.[1] ?? 0)
      const result = document.querySelector('#xc-result, .xc-result')
      const people = Number(result?.getAttribute('data-people') ?? (result?.querySelector('canvas') ? result.querySelectorAll('.xc-people li').length : 0))
      const basis = document.querySelector('#xc-basis, .xc-basis')?.textContent?.trim() ?? ''
      const alert = document.querySelector('#xc-error, .xc-error')
      const alertText = alert && !alert.hasAttribute('hidden') ? alert.textContent?.trim() ?? '' : ''
      const errorVisible = !!alertText
      const done = !errorVisible && (result?.getAttribute('data-state') === 'done' || (!!result?.querySelector('canvas') && !document.querySelector('.scan') && !document.querySelector('.xc-field.is-working')))
      const now = performance.now()
      if (marks.t0 && marks.first == null && (posts > 0 || mentions > 0 || people > 0)) marks.first = now
      marks.posts = Math.max(marks.posts, posts)
      marks.mentions = Math.max(marks.mentions, mentions)
      if (people > 0) marks.people = people
      if (basis) marks.basis = basis
      if (alertText) marks.error = alertText
      if (marks.t0 && done && marks.done == null) marks.done = now
    }
    new MutationObserver(read).observe(document.documentElement, { subtree: true, childList: true, characterData: true })
  })
}

async function prepare(page: Page, handle: string, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForSelector('#xc-handle', { timeout: 20_000 })
  await page.click('#xc-handle')
  await page.type('#xc-handle', handle, { delay: 0 })
  await arm(page)
}

async function start(page: Page): Promise<void> {
  await page.evaluate(() => {
    const marks = (window as unknown as { __marks: { t0: number } }).__marks
    marks.t0 = performance.now()
    document.querySelector<HTMLButtonElement>('#xc-go, button.xc-go[type="submit"]')?.click()
  })
}

async function finish(page: Page, handle: string, system: Sample['system']): Promise<Sample> {
  const deadline = Date.now() + 150_000
  let marks = { t0: 0, first: null as number | null, done: null as number | null, posts: 0, mentions: 0, people: 0, basis: '', error: '' }
  while (Date.now() < deadline) {
    marks = await page.evaluate(() => (window as unknown as { __marks: typeof marks }).__marks)
    if (marks.done != null || marks.error) break
    await Bun.sleep(300)
  }
  const basisPosts = Number(marks.basis.match(/from\s+(\d+)\s+post/)?.[1] ?? NaN)
  const postsProcessed = Number.isFinite(basisPosts) ? basisPosts : (marks.done ? marks.posts + marks.mentions : null)
  const completeMs = marks.done == null ? null : marks.done - marks.t0
  const firstProgressMs = marks.first == null ? null : marks.first - marks.t0
  const shot = await page.$('#xc-canvas, .xc-result canvas')
  if (shot) await shot.screenshot({ path: fileURLToPath(new URL(`${system}-${handle}.png`, OUT)) })
  return {
    system,
    handle,
    firstProgressMs,
    completeMs,
    postsProcessed,
    postsPerSec: completeMs && postsProcessed != null ? postsProcessed / (completeMs / 1000) : null,
    people: marks.people || null,
    basis: marks.basis,
    error: marks.error || (marks.done == null ? 'timed out before the circle finished' : undefined),
  }
}

function seconds(ms: number | null): string {
  if (ms == null) return '—'
  return `${(ms / 1000).toFixed(2)}s`
}

function rate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toFixed(1)
}

function page(samples: Sample[], accounts: string[]): string {
  const rows = accounts.map((handle) => {
    const before = samples.find((sample) => sample.handle === handle && sample.system === 'x-circle')
    const after = samples.find((sample) => sample.handle === handle && sample.system === 'fast-x-circle')
    const speed = before?.completeMs && after?.completeMs ? before.completeMs / after.completeMs : null
    return { handle, before, after, speed }
  })
  const body = rows.map(({ handle, before, after, speed }) => `
      <tr><td rowspan="2">@${handle}</td><td>X Circle</td><td>${seconds(before?.firstProgressMs ?? null)}</td><td>${seconds(before?.completeMs ?? null)}</td><td>${before?.postsProcessed ?? '—'}</td><td>${rate(before?.postsPerSec ?? null)}</td><td>${before?.people ?? '—'}</td></tr>
      <tr><td>Fast X Circle</td><td>${seconds(after?.firstProgressMs ?? null)}</td><td>${seconds(after?.completeMs ?? null)}</td><td>${after?.postsProcessed ?? '—'}</td><td>${rate(after?.postsPerSec ?? null)}</td><td>${after?.people ?? '—'}</td></tr>
      <tr class="sum"><td></td><td>Complete-circle speedup</td><td colspan="5">${speed ? `${speed.toFixed(2)}×` : '—'}${before?.error ? ` · X Circle: ${before.error}` : ''}${after?.error ? ` · Fast: ${after.error}` : ''}</td></tr>`).join('')
  const shots = rows.map(({ handle }) => `
      <figure>
        <img src="/evidence/x-circle-${handle}.png" alt="X Circle result for @${handle}" />
        <img src="/evidence/fast-x-circle-${handle}.png" alt="Fast X Circle result for @${handle}" />
        <figcaption>@${handle}: X Circle, then Fast X Circle</figcaption>
      </figure>`).join('')
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Benchmark · Fast X Circle</title>
  <link rel="stylesheet" href="/style.css" />
  <style>
    table { width: 100%; border-collapse: collapse; margin-top: 28px; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--cn-rule); vertical-align: top; }
    th { font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--cn-ink-2); }
    tr.sum td { color: var(--cn-ink-2); font-weight: 700; }
    figure { margin: 28px 0; display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    figure img { width: 100%; border-radius: 20px; background: var(--cn-navy); }
    figcaption { grid-column: 1 / -1; color: var(--cn-ink-2); font-weight: 700; }
    pre { white-space: pre-wrap; background: white; border: 1px solid var(--cn-rule); border-radius: 16px; padding: 16px; overflow: auto; }
  </style>
</head>
<body>
  <header class="top"><a class="brand" href="/">Fast X Circle</a><nav><a href="/">Circle</a><a href="/benchmark.html">Benchmark</a><a href="/report.html">Report</a></nav></header>
  <main class="xc">
    <h1 class="xc-title">Before and after</h1>
    <p class="xc-lead">Three public accounts with an empty x.md archive, measured in the browser. X Circle and Fast X Circle were started together. First progress is the first non-zero post count or the first drawn person. Complete is the finished circle. Posts are the posts the circle says it read, own posts and incoming mentions together. Posts per second uses the complete time.</p>
    <table>
      <thead><tr><th>Account</th><th></th><th>First progress</th><th>Complete circle</th><th>Posts</th><th>Posts/s</th><th>People</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${shots}
    <h2>Raw samples</h2>
    <pre>${JSON.stringify(samples, null, 2).replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]!))}</pre>
  </main>
</body>
</html>`
}

const pool = await pickAccounts()
console.log('pool', pool.join(','))
const accounts: string[] = []
await mkdir(OUT, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  protocolTimeout: 240_000,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 900 },
})
const samples: Sample[] = []
try {
  for (const handle of pool) {
    if (accounts.length >= 3) break
    const count = await archiveCount(handle)
    if (count !== null) {
      console.log('skip cached', handle)
      continue
    }
    console.log('measuring', handle)
    const original = await browser.newPage()
    const ours = await browser.newPage()
    const failed = (system: Sample['system'], message: string): Sample => ({ system, handle, firstProgressMs: null, completeMs: null, postsProcessed: null, postsPerSec: null, people: null, basis: '', error: message })
    try {
      await original.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
      await Promise.all([
        prepare(original, handle, ORIGINAL),
        prepare(ours, handle, `${OURS}/?fresh=1`),
      ])
      await Promise.all([start(original), start(ours)])
      const [before, after] = await Promise.all([
        finish(original, handle, 'x-circle').catch((error: unknown) => failed('x-circle', error instanceof Error ? error.message : 'failed')),
        finish(ours, handle, 'fast-x-circle').catch((error: unknown) => failed('fast-x-circle', error instanceof Error ? error.message : 'failed')),
      ])
      const usable = !before.error && !after.error && (before.postsProcessed ?? 0) > 0 && (after.postsProcessed ?? 0) > 0
      if (usable) accounts.push(handle)
      samples.push(before, after)
      console.log(JSON.stringify({ before, after, usable }))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed'
      samples.push(failed('x-circle', message), failed('fast-x-circle', message))
      console.log('account failed', handle, message)
    } finally {
      await original.close().catch(() => undefined)
      await ours.close().catch(() => undefined)
    }
  }
} finally {
  await browser.close()
}
await writeFile(new URL('../public/evidence/results.json', import.meta.url), JSON.stringify({ measuredAt: new Date().toISOString(), accounts, samples }, null, 2))
await writeFile(new URL('../public/benchmark.html', import.meta.url), page(samples, accounts))
console.log('wrote benchmark')
