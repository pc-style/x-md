/**
 * Before/after benchmark: the original X Circle and this demo, driven the same
 * way in a fresh headless Chrome context per run, measured the same way.
 *
 *   bun bench/run.ts --handles a,b,c [--demo http://localhost:8787] [--targets fast,original] [--allow-archived]
 *
 * Both pages render the same progress text ("N posts, M replies and mentions")
 * and draw the circle on a 1200px canvas, so one instrument fits both:
 *
 * - first visible progress: the progress text first shows a non-zero count;
 * - first circle: the first paint of the 1200px canvas;
 * - complete circle: the last canvas paint that draws profile photos, once the
 *   page shows its finished result and paints have been quiet for 2.5 s;
 * - posts processed: "… from N posts" under the circle (own posts + mentions).
 *
 * Times are measured in the page from the click on "Make my circle".
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import puppeteer, { type Browser } from 'puppeteer-core'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 1) {
  const [flag, inline] = process.argv[i].split('=')
  const next = process.argv[i + 1]
  if (inline !== undefined) args.set(flag, inline)
  else if (next && !next.startsWith('--')) { args.set(flag, next); i += 1 } else args.set(flag, 'true')
}
const handles = (args.get('--handles') ?? '').split(',').filter(Boolean)
const targets = (args.get('--targets') ?? 'fast,original').split(',') as ('fast' | 'original')[]
const DEMO = args.get('--demo') ?? 'http://localhost:8787'
const ORIGINAL = 'https://cut-noodle.com/x-circle'
const OUT = resolve(import.meta.dir, args.get('--out') ?? 'results')
const TIMEOUT = 150_000
if (!handles.length) { console.error('--handles a,b,c is required'); process.exit(1) }

interface Measure {
  target: 'fast' | 'original'
  handle: string
  startedAt: string
  archiveBefore: unknown
  firstProgressMs: number | null
  firstCircleMs: number | null
  completeMs: number | null
  postsProcessed: number | null
  people: number | null
  postsPerSecond: number | null
  basis: string | null
  error: string | null
  pageMarks?: unknown
}

async function archiveIndex(handle: string): Promise<unknown> {
  const key = process.env.X_MD_API_KEY
  if (!key) return 'unknown (no key)'
  const response = await fetch(`https://mdfromx.com/api/v1/profiles/${handle}/posts?index=true`, { headers: { Authorization: `Bearer ${key}` } })
  return ((await response.json()) as { archive: unknown }).archive
}

/** Installed before any page script: timestamps canvas paints and progress text, relative to the click. */
const INSTRUMENT = () => {
  const w = window as unknown as { __bench: { t0: number | null; firstProgress: number | null; firstCircle: number | null; lastPhoto: number | null; lastPaint: number | null } }
  w.__bench = { t0: null, firstProgress: null, firstCircle: null, lastPhoto: null, lastPaint: null }
  const b = w.__bench
  const rel = () => (b.t0 === null ? null : performance.now() - b.t0)
  const proto = CanvasRenderingContext2D.prototype
  const fillRect = proto.fillRect
  proto.fillRect = function (this: CanvasRenderingContext2D, ...a: [number, number, number, number]) {
    if (this.canvas.width === 1200 && a[2] === 1200 && b.t0 !== null) { const t = rel(); b.firstCircle ??= t; b.lastPaint = t }
    return fillRect.apply(this, a)
  }
  const drawImage = proto.drawImage as (...a: unknown[]) => void
  proto.drawImage = function (this: CanvasRenderingContext2D, ...a: unknown[]) {
    if (this.canvas.width === 1200 && b.t0 !== null) b.lastPhoto = rel()
    return drawImage.apply(this, a)
  } as typeof proto.drawImage
  const watch = () => {
    if (b.t0 === null || b.firstProgress !== null) return
    for (const em of document.querySelectorAll('.scan-steps em')) {
      const nums = (em.textContent ?? '').match(/\d[\d,]*/g)?.map((n) => Number(n.replace(/,/g, ''))) ?? []
      if (nums.some((n) => n > 0)) { b.firstProgress = rel(); return }
    }
  }
  new MutationObserver(watch).observe(document, { subtree: true, childList: true, characterData: true })
}

async function measure(browser: Browser, target: 'fast' | 'original', handle: string): Promise<Measure> {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: 1280, height: 1000 })
  await page.setCacheEnabled(false)
  await page.evaluateOnNewDocument(INSTRUMENT)
  const m: Measure = { target, handle, startedAt: new Date().toISOString(), archiveBefore: await archiveIndex(handle), firstProgressMs: null, firstCircleMs: null, completeMs: null, postsProcessed: null, people: null, postsPerSecond: null, basis: null, error: null }
  try {
    await page.goto(target === 'fast' ? DEMO : ORIGINAL, { waitUntil: 'networkidle2', timeout: 60_000 })
    await page.waitForSelector('#xc-handle', { timeout: 30_000 })
    await page.type('#xc-handle', handle)
    await page.evaluate(() => {
      const w = window as unknown as { __bench: { t0: number } }
      w.__bench.t0 = performance.now()
      const button = document.querySelector<HTMLButtonElement>('form button[type="submit"], button.xc-go')
      button?.click()
    })
    const deadline = Date.now() + TIMEOUT
    // Finished: the demo flags it; the original swaps the progress card for its result section.
    const finished = target === 'fast'
      ? () => page.evaluate(() => document.documentElement.dataset.xcState ?? '')
      : () => page.evaluate(() => (document.querySelector('.xc-result canvas') && !document.querySelector('.scan') ? 'complete' : document.querySelector('.xc-error') ? 'error' : ''))
    let state = ''
    while (Date.now() < deadline) {
      state = await finished()
      if (state === 'complete' || state === 'error') break
      await new Promise((r) => setTimeout(r, 100))
    }
    if (state !== 'complete') {
      m.error = state === 'error' ? await page.evaluate(() => document.querySelector('.xc-error')?.textContent ?? 'error') : 'timeout'
    } else {
      // Let the last photo paints land, then read the time of the final one.
      let last = -1
      for (let quiet = 0; quiet < 25 && Date.now() < deadline; ) {
        const now = await page.evaluate(() => (window as unknown as { __bench: { lastPaint: number | null; lastPhoto: number | null } }).__bench.lastPhoto ?? -1)
        quiet = now === last ? quiet + 1 : 0
        last = now
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const b = await page.evaluate(() => (window as unknown as { __bench: Record<string, number | null> }).__bench)
    m.firstProgressMs = round(b.firstProgress)
    m.firstCircleMs = round(b.firstCircle)
    m.basis = await page.evaluate(() => document.querySelector('.xc-basis')?.textContent ?? null)
    const basis = /([\d,]+) (?:person|people) from ([\d,]+) posts?/.exec(m.basis ?? '')
    if (basis) { m.people = Number(basis[1].replace(/,/g, '')); m.postsProcessed = Number(basis[2].replace(/,/g, '')) }
    if (!m.error) {
      m.completeMs = round(Math.max(b.lastPhoto ?? 0, b.lastPaint ?? 0) || null)
      if (m.completeMs && m.postsProcessed) m.postsPerSecond = Math.round((m.postsProcessed / (m.completeMs / 1000)) * 10) / 10
    }
    if (target === 'fast') m.pageMarks = await page.evaluate(() => (window as unknown as { __xc?: unknown }).__xc ?? null)
    await mkdir(OUT, { recursive: true })
    await page.evaluate(() => { document.querySelector('.xc-result')?.scrollIntoView({ block: 'start' }); window.scrollBy(0, -16) })
    await new Promise((r) => setTimeout(r, 300))
    await page.screenshot({ path: join(OUT, `${target}-${handle}.png`) as `${string}.png`, fullPage: false })
    const png = await page.evaluate(() => document.querySelector<HTMLCanvasElement>('.xc-stage canvas, .xc-result canvas')?.toDataURL('image/png') ?? null)
    if (png) await writeFile(join(OUT, `${target}-${handle}-circle.png`), Buffer.from(png.split(',')[1], 'base64'))
  } catch (error) {
    m.error = (error as Error).message
  } finally {
    await context.close()
  }
  return m
}

const round = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(v))

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const results: Measure[] = []
try {
  for (const handle of handles) {
    for (const target of targets) {
      process.stdout.write(`${target.padEnd(8)} @${handle} … `)
      const m = await measure(browser, target, handle)
      results.push(m)
      console.log(m.error ? `ERROR ${m.error}` : `progress ${m.firstProgressMs} ms · first circle ${m.firstCircleMs} ms · complete ${m.completeMs} ms · ${m.postsProcessed} posts · ${m.postsPerSecond}/s`)
    }
  }
} finally {
  await browser.close()
}
await mkdir(OUT, { recursive: true })
const file = join(OUT, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
await writeFile(file, JSON.stringify({ demo: DEMO, original: ORIGINAL, handles, results }, null, 2))
console.log(`wrote ${file}`)
