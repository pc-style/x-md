/**
 * Critical-path budget for the browser-facing pages.
 *
 * Answers the question the landing/about/docs load is judged on: how many bytes
 * and how many requests sit between the first byte of the HTML and a painted
 * first screen. It walks the eager subresource graph a browser actually builds
 * from `dist/`:
 *
 *   HTML -> render-blocking <link rel=stylesheet> -> CSS @import chain -> @font-face src
 *        -> <script type=module> + <link rel=modulepreload> -> static import graph
 *
 * Sizes are brotli transfer sizes, which is what Vercel serves. External
 * origins (the Fontshare CDN) are measured through a small on-disk cache so the
 * benchmark stays offline and repeatable.
 *
 *   bun bench/frontend-load.ts                      # all pages of ./dist
 *   bun bench/frontend-load.ts / /about             # a subset
 *   bun bench/frontend-load.ts --dist ../other/dist # another build
 */
import { brotliCompressSync, constants } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(distFlag(process.argv) ?? join(ROOT, 'dist'))

/** `--dist <dir>` measures a saved copy of `dist/`, so before and after run the same code. */
function distFlag(argv: string[]): string | null {
  const at = argv.indexOf('--dist')
  return at === -1 ? null : argv[at + 1]
}
const EXTERNAL_CACHE = join(ROOT, 'node_modules', '.cache', 'x-md-bench-external')

const PAGES: Record<string, string> = {
  landing: 'index.html',
  about: 'about.html',
  docs: 'docs/index.html',
}

const br = (buffer: Buffer): number =>
  brotliCompressSync(buffer, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: buffer.length },
  }).length

/** External subresources (fonts) are cached on disk so repeat runs stay offline. */
/** External subresources are cached on disk so repeat runs stay offline. */
function readExternal(url: string): Buffer {
  mkdirSync(EXTERNAL_CACHE, { recursive: true })
  const file = join(EXTERNAL_CACHE, Buffer.from(url).toString('base64url') + '.bin')
  if (existsSync(file)) return readFileSync(file)
  const response = fetchSync(url)
  if (response.status !== 200) throw new Error(`${url} -> ${response.status}`)
  writeFileSync(file, Buffer.from(response.data))
  return readFileSync(file)
}

function fetchSync(url: string): { status: number; data: Uint8Array } {
  const proc = Bun.spawnSync(['curl', '-sS', '--compressed', '--max-time', '20', '-w', '\n%{http_code}', url])
  if (proc.exitCode !== 0) throw new Error(new TextDecoder().decode(proc.stderr))
  const out = proc.stdout
  const cut = out.lastIndexOf(10)
  return { status: Number(new TextDecoder().decode(out.subarray(cut + 1))), data: out.subarray(0, cut) }
}

type Asset = {
  url: string
  kind: 'html' | 'css' | 'js' | 'font'
  raw: number
  transfer: number
}

function statAsset(url: string, kind: Asset['kind'], source: Buffer | string): Asset {
  const buffer = typeof source === 'string' ? Buffer.from(source) : source
  // Fonts and images are already compressed; brotli would only add bytes, so
  // the transfer size is the file size (this is what a CDN sends too).
  const compressed = kind === 'font' ? buffer.length : br(buffer)
  return { url, kind, raw: buffer.length, transfer: compressed }
}

const ATTR = (tag: string, name: string) =>
  new RegExp(`<${tag}\\b[^>]*\\b${name}\\s*=\\s*["']([^"']+)["']`, 'gi')

function tags(html: string, tag: string) {
  return html.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) ?? []
}

/** Render-blocking stylesheets: no `media` that can fail, no `onload` trick, not `disabled` (never fetched). */
function blockingStylesheets(html: string): string[] {
  return tags(html, 'link')
    .filter(tag => /rel\s*=\s*["']stylesheet["']/i.test(tag) && !/\bmedia\s*=/i.test(tag) && !/\bdisabled\b/i.test(tag))
    .flatMap(tag => [...tag.matchAll(ATTR('link', 'href'))].map(m => m[1]))
}

/** Webfonts the document asks for before anything else. */
function preloadedFonts(html: string): string[] {
  return tags(html, 'link')
    .filter(tag => /rel\s*=\s*["']preload["']/i.test(tag) && /\bas=["']font["']/i.test(tag))
    .flatMap(tag => [...tag.matchAll(ATTR('link', 'href'))].map(m => m[1]))
}

/** Eagerly fetched JavaScript: module scripts and modulepreload hints. */
function eagerScripts(html: string): string[] {
  const scripts = tags(html, 'script')
    .filter(tag => /\bsrc\s*=/i.test(tag))
    .flatMap(tag => [...tag.matchAll(ATTR('script', 'src'))].map(m => m[1]))
  const preloads = tags(html, 'link')
    .filter(tag => /rel\s*=\s*["']modulepreload["']/i.test(tag))
    .flatMap(tag => [...tag.matchAll(ATTR('link', 'href'))].map(m => m[1]))
  return [...scripts, ...preloads]
}

const IMPORT_RE = /\bimport\s*(?:[\s\S]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g
const CSS_IMPORT_RE = /@import\s+(?:url\()?["']([^"']+)["']/g
const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/g

function fontUrls(css: string, base: string, seen: Set<string>): string[] {
  const urls: string[] = []
  for (const block of css.matchAll(FONT_FACE_RE)) {
    // Every declared face counts, whatever the family: the docs page declares
    // Satoshi and IBM Plex Mono, and a face the browser may download is a face
    // this budget has to account for.
    // A browser only downloads the first format it can render: woff2.
    const woff2 = [...block[1].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)\s*format\(\s*["']woff2["']/gi)]
      .map(match => match[1])[0]
      ?? [...block[1].matchAll(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/gi)].map(match => match[1])[0]
    if (!woff2) continue
    const url = absolute(woff2, base)
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function absolute(href: string, base: string): string | null {
  if (/^https?:\/\//i.test(href)) return href
  try {
    // `base` is either a path (`/index.html`) or an already-absolute URL.
    return new URL(href, /^https?:\/\//i.test(base) ? base : `https://x.md${base}`).href
  } catch {
    return null
  }
}

const localPath = (url: string) => {
  const path = join(DIST, new URL(url, 'https://x.md').pathname)
  return existsSync(path) && statSync(path).isFile() ? path : null
}

/** Always binary: webfonts must not be round-tripped through a text decoder. */
function read(url: string): Buffer {
  const local = localPath(url)
  return local ? readFileSync(local) : readExternal(url)
}

function collect(entry: string) {
  const assets: Asset[] = []
  const seen = new Set<string>()
  const jsSeen = new Set<string>()

  const html = readFileSync(join(DIST, entry), 'utf8')
  assets.push(statAsset(`/${entry}`, 'html', html))

  // Inlined <style> is render-blocking CSS too, and it is where the webfonts
  // live once the stylesheet plugin has inlined it.
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1])

  // Render-blocking CSS, its @import chain, and the webfonts those sheets need.
  const styles = blockingStylesheets(html)
  const cssSeen = new Set<string>()
  const fontSeen = new Set<string>()
  const queue = [...styles]
  while (queue.length) {
    const href = queue.shift()!
    const url = absolute(href, `/${entry}`)
    if (!url || seen.has(url)) continue
    seen.add(url)
    cssSeen.add(url)
    let css: Buffer
    try {
      css = read(url)
    } catch {
      continue
    }
    assets.push(statAsset(url, 'css', css))
    for (const match of css.toString('latin1').matchAll(CSS_IMPORT_RE)) {
      const imported = absolute(match[1], url)
      if (imported) queue.push(imported)
    }
    for (const font of fontUrls(css.toString('latin1'), url, fontSeen)) {
      assets.push(statAsset(font, 'font', read(font)))
    }
  }

  for (const css of inlineCss) {
    for (const font of fontUrls(css, `/${entry}`, fontSeen)) {
      assets.push(statAsset(font, 'font', read(font)))
    }
  }

  // Webfonts the document preloads, plus every font face in the CSS.
  for (const href of preloadedFonts(html)) {
    const url = absolute(href, `/${entry}`)
    if (!url || fontSeen.has(url)) continue
    fontSeen.add(url)
    try {
      assets.push(statAsset(url, 'font', read(url)))
    } catch { /* an unreachable preload must not fail the budget */ }
  }

  // Eager JavaScript and the modules it statically pulls in.
  for (const href of eagerScripts(html)) {
    const url = absolute(href, `/${entry}`)!
    const jsQueue = [url]
    while (jsQueue.length) {
      const next = jsQueue.shift()!
      if (jsSeen.has(next)) continue
      jsSeen.add(next)
      let code: Buffer
      try {
        code = read(next)
      } catch {
        continue
      }
      assets.push(statAsset(next, 'js', code))
      for (const match of code.toString('latin1').matchAll(IMPORT_RE)) {
        jsQueue.push(new URL(match[1], next).href)
      }
    }
  }

  const sum = (kind: Asset['kind']) =>
    assets.filter(a => a.kind === kind).reduce((n, a) => n + a.transfer, 0)
  const requests = (kind: Asset['kind']) => assets.filter(a => a.kind === kind).length
  const renderBlocking = sum('css') + sum('js') + sum('font')
  const mainThreadJs = assets.filter(a => a.kind === 'js').reduce((n, a) => n + a.raw, 0)

  return {
    assets,
    bytes: {
      html: sum('html'),
      css: sum('css'),
      js: sum('js'),
      font: sum('font'),
      renderBlocking,
      mainThreadJs,
      total: sum('html') + renderBlocking,
    },
    requests: {
      css: requests('css'),
      js: requests('js'),
      font: requests('font'),
      beforeFirstRender: 1 + requests('css') + requests('js') + requests('font'),
    },
  }
}

const kb = (n: number) => (n / 1024).toFixed(1).padStart(7)
const pageArgs = process.argv.slice(2).filter((arg, i, all) => arg !== '--dist' && all[i - 1] !== '--dist')
const report = (slug: string, entry: string) => {
  const result = collect(entry)
  console.log(`\n${slug}  (/${entry})`)
  console.log(`  requests before first render : ${result.requests.beforeFirstRender}`)
  console.log(`  render-blocking brotli bytes : ${kb(result.bytes.renderBlocking)} kB  <- headline`)
  console.log(`  main-thread JS (raw)         : ${kb(result.bytes.mainThreadJs)} kB`)
  console.log(`    html                       : ${kb(result.bytes.html)} kB`)
  console.log(`    css  (${result.requests.css} req)               : ${kb(result.bytes.css)} kB`)
  console.log(`    js   (${result.requests.js} req)               : ${kb(result.bytes.js)} kB`)
  console.log(`    font (${result.requests.font} req)               : ${kb(result.bytes.font)} kB`)
  for (const asset of result.assets) {
    if (asset.kind === 'html') continue
    console.log(`      ${kb(asset.transfer)} kB br  ${String(kb(asset.raw)).trimStart()} kB raw  ${asset.kind.padEnd(4)} ${asset.url.replace('https://mdfromx.com', '')}`)
  }
  return result
}

if (!existsSync(DIST)) throw new Error('dist/ is missing; run `bun run build` first')
const total = { renderBlocking: 0, mainThreadJs: 0, requests: 0 }
for (const [slug, entry] of Object.entries(PAGES)) {
  if (pageArgs.length && !pageArgs.some(arg => arg === slug || arg === `/${entry}` || arg === `/${slug}`)) continue
  const result = report(slug, entry)
  total.renderBlocking += result.bytes.renderBlocking
  total.mainThreadJs += result.bytes.mainThreadJs
  total.requests += result.requests.beforeFirstRender
}
console.log(`\nTOTAL render-blocking ${kb(total.renderBlocking)} kB br  main-thread JS ${kb(total.mainThreadJs)} kB raw  requests ${total.requests}`)