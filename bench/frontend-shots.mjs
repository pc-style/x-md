/**
 * Screenshot harness for the frontend slice.
 *
 *   node bench/frontend-shots.mjs --out /tmp/shots --label current
 *   node bench/frontend-shots.mjs --dist ../other/dist --label before
 *
 * Captures the landing page, /about and /docs at desktop and mobile widths,
 * light and dark, in both motion states, so a byte-level change to the build can
 * be compared against another build by eye or by pixel diff.
 *
 * Playwright comes from PLAYWRIGHT_MODULE (or --module) so the repo's own
 * dependency tree stays untouched.
 */
import { createServer } from 'node:http'
import { brotliCompress } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1] }
const OUT = flag('out', '/tmp/opencode/shots')
const LABEL = flag('label', 'current')
const ONLY = flag('page', null)

const ROOT = resolve(import.meta.dirname, '..')
/** Point at another build (a sibling worktree's `dist`, a saved copy) to diff against. */
const DIST = resolve(flag('dist', join(ROOT, 'dist')))
/** Playwright is resolved from PLAYWRIGHT_MODULE so the repo's own dependencies stay untouched. */
const require = createRequire(`${flag('module', process.env.PLAYWRIGHT_MODULE ?? '/tmp/')}/package.json`)
const { chromium } = require('playwright-core')
const EXECUTABLE = join(process.env.HOME ?? '/root', '.cache/ms-playwright/chromium-1243/chrome-linux64/chrome')

const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.json', '.md', '.txt', '.svg', '.webmanifest', '.xml'])
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x.md').pathname)
  let file = normalize(join(DIST, path))
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file)) { const flat = join(DIST, `${path.replace(/\/$/, '')}.html`); if (existsSync(flat)) file = flat; else { res.writeHead(404).end('not found'); return } }
  const ext = extname(file)
  const body = readFileSync(file)
  const headers = { 'content-type': TYPES[ext] ?? 'application/octet-stream' }
  if (COMPRESSIBLE.has(ext)) {
    headers['content-encoding'] = 'br'
    res.writeHead(200, headers)
    res.end(await new Promise((ok, no) => brotliCompress(body, { params: { 1: 5 } }, (e, o) => e ? no(e) : ok(o))))
    return
  }
  res.writeHead(200, headers)
  res.end(body)
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--font-render-hinting=none'] })
mkdirSync(OUT, { recursive: true })

const PAGES = ONLY ? { [ONLY]: ONLY } : { '/': '/index.html', '/about': '/about.html', '/docs': '/docs/index.html' }
const VIEWPORTS = { desktop: { width: 1350, height: 940 }, mobile: { width: 390, height: 844 } }
const FONT_CACHE = join(process.env.HOME ?? '/root', '.cache/x-md-bench-fonts')

for (const [route, entry] of Object.entries(PAGES)) {
  for (const [device, viewport] of Object.entries(VIEWPORTS)) {
    for (const scheme of ['light', 'dark']) {
      for (const motion of ['no-preference', 'reduce']) {
        const context = await browser.newContext({ viewport, colorScheme: scheme, reducedMotion: motion, deviceScaleFactor: 1 })
        const page = await context.newPage()
        await page.route(/cdn\.fontshare\.com/, async route => {
          const file = join(FONT_CACHE, Buffer.from(route.request().url()).toString('base64url') + '.bin')
          if (!existsSync(file)) { const r = await fetch(route.request().url()); mkdirSync(FONT_CACHE, { recursive: true }); writeFileSync(file, Buffer.from(await r.arrayBuffer())) }
          await route.fulfill({ status: 200, body: readFileSync(file), headers: { 'content-type': 'font/woff2', 'access-control-allow-origin': '*' } })
        })
        await page.goto(origin + entry, { waitUntil: 'load' })
        // Let the hero reveal finish, or skip it under reduced motion.
        await page.waitForTimeout(2200)
        const name = `${LABEL}-${route.replace(/\W+/g, '_') || 'root'}-${device}-${scheme}-${motion === 'reduce' ? 'still' : 'motion'}.png`
        await page.screenshot({ path: join(OUT, name), fullPage: false })
        // One full-page capture per page for layout comparison.
        if (device === 'desktop' && scheme === 'light' && motion === 'no-preference') {
          await page.screenshot({ path: join(OUT, `${LABEL}-${route.replace(/\W+/g, '_') || 'root'}-full.png`), fullPage: true })
        }
        await context.close()
      }
    }
  }
}
await browser.close()
server.close()
console.log(`shots written to ${OUT}`)