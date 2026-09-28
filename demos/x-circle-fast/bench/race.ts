/**
 * Side-by-side race video: the original and the demo start on the same account
 * at the same moment, each recorded in its own headless Chrome page, then
 * stacked left/right with ffmpeg.
 *
 *   bun bench/race.ts --handle someone [--demo URL] [--out results/race.mp4]
 */
import { mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import puppeteer, { type Page } from 'puppeteer-core'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const handle = args.get('--handle')
const demo = args.get('--demo') ?? 'http://localhost:8787'
const out = resolve(import.meta.dir, args.get('--out') ?? 'results/race.mp4')
if (!handle) { console.error('--handle is required'); process.exit(1) }
await mkdir(dirname(out), { recursive: true })

const browser = await puppeteer.launch({ executablePath: process.env.CHROME ?? '/usr/local/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const W = 900
const H = 1100

async function open(url: string): Promise<Page> {
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setViewport({ width: W, height: H })
  await page.setCacheEnabled(false)
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 })
  await page.type('#xc-handle', handle!)
  // A label and a stopwatch painted into the page itself, so the video carries its own timing.
  await page.evaluate((label: string) => {
    const tag = document.createElement('div')
    tag.id = 'race-tag'
    tag.style.cssText = 'position:fixed;top:10px;right:10px;z-index:99999;background:#00123b;color:#fede95;font:800 22px/1.2 system-ui;padding:10px 16px;border-radius:12px;font-variant-numeric:tabular-nums'
    tag.textContent = `${label} · 0.0 s`
    document.body.appendChild(tag)
    const w = window as unknown as { __raceStart?: number; __raceStop?: boolean }
    const tick = () => {
      if (w.__raceStart !== undefined && !w.__raceStop) tag.textContent = `${label} · ${((performance.now() - w.__raceStart) / 1000).toFixed(1)} s`
      requestAnimationFrame(tick)
    }
    tick()
  }, url === demo ? 'Fast demo' : 'Original')
  return page
}

const [original, fast] = await Promise.all([open('https://cut-noodle.com/x-circle'), open(demo)])
const files = { original: out.replace(/\.mp4$/, '-original.webm'), fast: out.replace(/\.mp4$/, '-fast.webm') }
const recorders = await Promise.all([original.screencast({ path: files.original as `${string}.webm` }), fast.screencast({ path: files.fast as `${string}.webm` })])
await new Promise((r) => setTimeout(r, 800))
const go = (page: Page) => page.evaluate(() => {
  ;(window as unknown as { __raceStart: number }).__raceStart = performance.now()
  document.querySelector<HTMLButtonElement>('button.xc-go')?.click()
})
await Promise.all([go(original), go(fast)])

const finished = {
  fast: () => fast.evaluate(() => document.documentElement.dataset.xcState === 'complete'),
  original: () => original.evaluate(() => Boolean(document.querySelector('.xc-result canvas')) && !document.querySelector('.scan')),
}
// Both pages scroll to their circle the moment one is on screen, so the video shows
// each circle as soon as it exists rather than below the fold.
const circleShown = (page: Page) => page.evaluate(() => {
  const section = document.querySelector<HTMLElement>('.xc-result')
  return Boolean(section && !section.hidden && section.querySelector('canvas'))
})
const deadline = Date.now() + 120_000
const done = { fast: false, original: false }
const scrolled = { fast: false, original: false }
while (Date.now() < deadline && !(done.fast && done.original)) {
  for (const key of ['fast', 'original'] as const) {
    const page = key === 'fast' ? fast : original
    if (!scrolled[key] && (await circleShown(page))) {
      scrolled[key] = true
      await page.evaluate(() => document.querySelector('.xc-result')?.scrollIntoView({ block: 'start' }))
    }
    if (done[key] || !(await finished[key]())) continue
    done[key] = true
    await page.evaluate(() => { (window as unknown as { __raceStop: boolean }).__raceStop = true })
  }
  await new Promise((r) => setTimeout(r, 100))
}
await new Promise((r) => setTimeout(r, 2500))
await Promise.all(recorders.map((r) => r.stop()))
await browser.close()

const ffmpeg = Bun.spawn(['ffmpeg', '-y', '-loglevel', 'error', '-i', files.original, '-i', files.fast,
  '-filter_complex', `[0:v]scale=${W}:${H},setsar=1[a];[1:v]scale=${W}:${H},setsar=1[b];[a][b]hstack=inputs=2[v]`,
  '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-preset', 'veryfast', out], { stdout: 'inherit', stderr: 'inherit' })
const code = await ffmpeg.exited
await rm(files.original, { force: true })
await rm(files.fast, { force: true })
console.log(code === 0 ? `wrote ${out}` : `ffmpeg failed (${code})`)
