/**
 * Simulated-throttled LCP/TBT for the browser-facing pages.
 *
 * Serves `dist/` over loopback with brotli (what Vercel sends), then loads the
 * page in headless Chromium with a Lighthouse "Slow 4G" network profile and a 4x
 * CPU slowdown. Reports median and p90 over N cold loads.
 *
 *   node bench/frontend-trace.mjs [--runs 7] [--page /] [--cpu 4] [--dist path]
 *   node bench/frontend-trace.mjs --compare dist-before,dist --runs 15
 *
 * `--dist` points the harness at another build (a saved copy of `dist/`, a
 * sibling worktree) so a before/after comparison runs the same code twice.
 *
 * Playwright is resolved from PLAYWRIGHT_MODULE (default /tmp) or --module
 * so the repo's own dependency tree is untouched.
 */
import { createServer } from 'node:http'
import { brotliCompress } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}
const RUNS = Number(flag('runs', 7))
const CPU = Number(flag('cpu', 4))
const ONLY = flag('page', null)

// Lighthouse's Slow 4G: 1.6 Mbps down, 750 Kbps up, 150 ms RTT.
const NETWORK = { offline: false, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8, latency: 150 }
const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(flag('dist', join(ROOT, 'dist')))
const require = createRequire(flag('module', '/tmp/') + '/package.json')
const { chromium } = require('playwright-core')
const EXECUTABLE = process.env.CHROMIUM_PATH
  ?? join(process.env.HOME ?? '/root', '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')

const PAGES = ONLY ? { [ONLY]: ONLY.replace(/^\/docs.*$/, '/docs/index.html') } : {
  '/': '/index.html',
  '/about': '/about.html',
  '/docs': '/docs/index.html',
}

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.svg', '.webmanifest', '.xml'])
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
}

/** Serves one build directory, brotli-encoding text exactly as Vercel does. */
const staticServer = (dist) => createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x.md').pathname)
  let file = normalize(join(dist, path))
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) {
    const flat = join(dist, `${path.replace(/\/$/, '')}.html`)
    if (existsSync(flat)) file = flat
    else { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return }
  }
  const ext = extname(file)
  const body = readFileSync(file)
  const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' }
  // Fonts and images ship as-is; text is served brotli-encoded, like Vercel.
  if (COMPRESSIBLE.has(ext)) {
    headers['content-encoding'] = 'br'
    res.writeHead(200, headers)
    res.end(await new Promise((done, fail) => brotliCompress(body, { params: { 1: 5 } }, (err, out) => err ? fail(err) : done(out))))
    return
  }
  res.writeHead(200, headers)
  res.end(body)
})

const listen = (s) => new Promise(done => s.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${s.address().port}`)))
const close = (s) => new Promise(done => s.close(done))

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
})

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]
}
const median = (values) => quantile(values, 0.5)

// The upstream webfont CDN is answered from a local disk copy so the run is
// hermetic and repeatable: no DNS, no TLS, no third-party jitter. Baseline and
// post-change numbers are therefore comparable.
const FONT_CACHE = join(process.env.HOME ?? '/root', '.cache/x-md-bench-fonts')
const fontOverrides = new Map()
let runFontBytes = 0

const INIT_PROBE = () => {
  window.__metrics = { lcp: 0, lcpEl: '', longTasks: [], cls: 0, heroReadable: 0 }
  // The hero headline is the landing page's largest contentful element and is
  // animated from opacity 0. LCP records it when the animation *ends*, but a
  // visitor can only start reading it once it is actually opaque, so track that
  // separately: it is comparable across builds whether or not they animate it.
  // Start after load: before the render-blocking stylesheet applies, every
  // element is unstyled and reports opacity 1, which would record "readable"
  // for a hero nobody can read yet.
  addEventListener('load', () => {
    const poll = () => {
      const hero = document.querySelector('h1.hero-h')
      if (hero && Number(getComputedStyle(hero).opacity) >= 0.9) {
        window.__metrics.heroReadable = Math.round(performance.now())
        return
      }
      requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  })
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      window.__metrics.lcp = entry.startTime
      window.__metrics.lcpEl = entry.element
        ? entry.element.tagName.toLowerCase() + '.' + String(entry.element.className || '').split(' ')[0]
        : ''
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true })
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__metrics.longTasks.push(entry.duration)
  }).observe({ type: 'longtask', buffered: true })
}

/**
 * `--compare dirA,dirB` alternates runs between two builds so the machine's own
 * noise lands on both sides of the comparison instead of only one. Without it a
 * busy box can move TBT by more than the change under test.
 */
const COMPARE = flag('compare', null)
const BUILDS = COMPARE ? COMPARE.split(',').map(dir => ({ label: dir.split('/').filter(Boolean).slice(-1)[0], dir: resolve(dir) })) : [{ label: 'dist', dir: DIST }]
const servers = []
for (const build of BUILDS) {
  const server = staticServer(build.dir)
  servers.push(server)
  build.origin = await listen(server)
}

const sample = async (origin, entry) => {
  // A fresh context per run: no HTTP cache, no storage, no warm renderer state.
  runFontBytes = 0
  const context = await browser.newContext({
    viewport: { width: 1350, height: 940 },
    reducedMotion: process.env.REDUCED_MOTION === '1' ? 'reduce' : 'no-preference',
  })
  const page = await context.newPage()
  await page.route(/cdn\.fontshare\.com/, async route => {
    const file = join(FONT_CACHE, Buffer.from(route.request().url()).toString('base64url') + '.bin')
    if (!existsSync(file)) {
      const response = await fetch(route.request().url())
      mkdirSync(FONT_CACHE, { recursive: true })
      writeFileSync(file, Buffer.from(await response.arrayBuffer()))
    }
    fontOverrides.set(route.request().url(), statSync(file).size)
    runFontBytes += statSync(file).size
    await route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*', 'timing-allow-origin': '*' } })
  })
  await page.addInitScript(INIT_PROBE)
  const client = await context.newCDPSession(page)
  await client.send('Network.enable')
  await client.send('Network.setCacheDisabled', { cacheDisabled: true })
  await client.send('Network.emulateNetworkConditions', NETWORK)
  await client.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  await page.goto(origin + entry, { waitUntil: 'load' })
  // Give idle-loaded chunks and late fonts the window a real visit would have.
  await page.waitForTimeout(5000)
  const probe = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const paint = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, e.startTime]))
    const bytes = { css: 0, js: 0, font: 0 }
    const counts = { css: 0, js: 0, font: 0 }
    const resources = performance.getEntriesByType('resource')
    let requests = 0
    let requestsBeforePaint = 0
    const fcp = paint['first-contentful-paint'] ?? 0
    for (const r of resources) {
      requests += 1
      if (r.responseEnd <= fcp) requestsBeforePaint += 1
      const kind = /\.css($|\?)/.test(r.name) ? 'css'
        : /\.m?js($|\?)/.test(r.name) ? 'js'
        : /\.woff2?($|\?)/.test(r.name) ? 'font' : null
      if (!kind) continue
      // Cross-origin font responses carry no Timing-Allow-Origin, so the
      // browser reports transferSize 0; fall back to the bytes we served.
      bytes[kind] += r.transferSize || 0
      counts[kind] += 1
    }
    const { lcp, longTasks } = window.__metrics
    return {
      lcp: Math.round(lcp),
      heroReadable: window.__metrics.heroReadable,
      fcp: Math.round(paint['first-contentful-paint'] ?? 0),
      tbt: Math.round(longTasks.reduce((t, d) => t + Math.max(0, d - 50), 0)),
      longTasks: Math.round(longTasks.reduce((t, d) => t + d, 0)),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      requests: requests + 1,
      requestsBeforePaint: requestsBeforePaint + 1,
      lcpEl: window.__metrics.lcpEl,
      counts,
      bytes,
    }
  })
  probe.fontBytesServed = runFontBytes
  await context.close()
  return probe
}

const summarise = (samples) => {
  const pick = fn => ({ median: median(samples.map(fn)), p90: quantile(samples.map(fn), 0.9) })
  return {
    runs: samples.length,
    lcp: pick(s => s.lcp),
    heroReadable: pick(s => s.heroReadable),
    fcp: pick(s => s.fcp),
    tbt: pick(s => s.tbt),
    longTasks: pick(s => s.longTasks),
    load: pick(s => s.load),
    requests: pick(s => s.requests),
    requestsBeforePaint: pick(s => s.requestsBeforePaint),
    lcpEl: samples.find(s => s.lcpEl)?.lcpEl ?? '',
    css: pick(s => s.counts.css),
    js: pick(s => s.counts.js),
    font: pick(s => s.counts.font),
    cssBytes: pick(s => Math.round(s.bytes.css / 1024)),
    jsBytes: pick(s => Math.round(s.bytes.js / 1024)),
    // Cross-origin webfonts report transferSize 0 without Timing-Allow-Origin,
    // so font bytes come from what the interception actually served.
    fontBytes: pick(s => Math.round((s.bytes.font || s.fontBytesServed) / 1024)),
  }
}

const collected = []
for (const [route, entry] of Object.entries(PAGES)) {
  const per = new Map(BUILDS.map(build => [build.label, []]))
  // Alternate build per run so a slow patch of the machine hits both evenly.
  for (let run = 0; run < RUNS; run += 1) {
    const build = BUILDS[run % BUILDS.length]
    per.get(build.label).push(await sample(build.origin, entry))
  }
  for (const [label, samples] of per) collected.push({ build: label, route, ...summarise(samples) })
}

await browser.close()
for (const server of servers) await close(server)

console.log(`throttle: Slow 4G (1.6 Mbps / 150 ms RTT), CPU ${CPU}x, cold cache, ${RUNS} runs per build\n`)
const pad = (s, n) => String(s).padStart(n)
console.log(`${pad('build', 12)}${pad('route', 8)}${pad('LCP med', 9)}${pad('LCP p90', 9)}${pad('readable', 10)}${pad('FCP med', 9)}${pad('TBT med', 9)}${pad('TBT p90', 9)}${pad('JS longtask', 12)}${pad('load', 7)}${pad('pre', 5)}${pad('reqs', 6)}${pad('CSS kB', 8)}${pad('JS kB', 7)}${pad('font kB', 9)}`)
for (const row of collected) {
  console.log(`${pad(row.build, 12)}${pad(row.route, 8)}${pad(row.lcp.median, 9)}${pad(row.lcp.p90, 9)}${pad(row.heroReadable.median || '-', 10)}${pad(row.fcp.median, 9)}${pad(row.tbt.median, 9)}${pad(row.tbt.p90, 9)}${pad(row.longTasks.median, 12)}${pad(row.load.median, 7)}${pad(row.requestsBeforePaint.median, 5)}${pad(row.requests.median, 6)}${pad(row.cssBytes.median, 8)}${pad(row.jsBytes.median, 7)}${pad(row.fontBytes.median, 9)}`)
}
console.log(`\nms for LCP/FCP/TBT, kB transfer as the browser counted it (already brotli).`)
console.log(`pre = requests that finished before first contentful paint; reqs = every request in the run.`)
console.log(`readable = when the hero headline first reached 90% opacity (landing only).`)
for (const row of collected) console.log(`  ${row.build} ${row.route} LCP element: ${row.lcpEl}`)
if (process.env.BENCH_JSON) {
  writeFileSync(process.env.BENCH_JSON, JSON.stringify({ network: NETWORK, cpu: CPU, runs: RUNS, rows: collected }, null, 2))
  console.log(`wrote ${process.env.BENCH_JSON}`)
}