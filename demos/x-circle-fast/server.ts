import { readdir, stat } from 'node:fs/promises'
import { join, normalize, relative } from 'node:path'
import { cleanHandle } from './src/core.ts'
import { DEFAULTS, harvest, resolveProfiles, type HarvestEvent } from './src/harvest.ts'

const ROOT = import.meta.dir
const PORT = Number(process.env.PORT ?? 8787)
const BASE = process.env.X_MD_BASE ?? 'https://mdfromx.com'
const KEY = process.env.X_MD_API_KEY ?? ''
if (!KEY) {
  console.error('X_MD_API_KEY is not set')
  process.exit(1)
}

const build = await Bun.build({ entrypoints: [join(ROOT, 'src/client.ts')], minify: true, target: 'browser', sourcemap: 'none' })
if (!build.success) {
  for (const log of build.logs) console.error(log)
  process.exit(1)
}
const clientJs = await build.outputs[0].text()

/** Fixed-window counters per client IP: the key sits behind a public URL, so one visitor must not be able to spend its allowance. */
const windows = new Map<string, { start: number; count: number }>()
function allow(bucket: string, ip: string, limit: number, windowMs: number): number | null {
  const key = `${bucket}:${ip}`
  const now = Date.now()
  const entry = windows.get(key)
  if (!entry || now - entry.start > windowMs) { windows.set(key, { start: now, count: 1 }); return null }
  if (entry.count >= limit) return Math.ceil((entry.start + windowMs - now) / 1000)
  entry.count += 1
  return null
}
const CIRCLES_PER_IP = Number(process.env.CIRCLES_PER_IP ?? 12)

const clientIp = (req: Request, server: Bun.Server<undefined>): string =>
  req.headers.get('cf-connecting-ip') ?? server.requestIP(req)?.address ?? 'unknown'

function stream(run: (write: (value: unknown) => void, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (value: unknown) => { if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(value) + '\n')) }
      try { await run(write, signal) } finally { if (!signal.aborted) controller.close() }
    },
  })
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } })
}

const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra } })

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.ndjson': 'application/x-ndjson; charset=utf-8',
}
const SOURCE_TEXT = new Set(['.ts', '.md', '.json', '.css', '.html', '.txt', '.ndjson'])
const HIDDEN = /(^|\/)(\.env|node_modules|\.git)(\/|$)/

async function file(path: string, asSource = false): Promise<Response | null> {
  const f = Bun.file(path)
  if (!(await f.exists())) return null
  const ext = path.slice(path.lastIndexOf('.'))
  const type = asSource && SOURCE_TEXT.has(ext) ? 'text/plain; charset=utf-8' : TYPES[ext] ?? 'application/octet-stream'
  return new Response(f, { headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' } })
}

async function listing(dir: string, urlPath: string): Promise<Response> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => !HIDDEN.test(e.name)).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const items = entries.map((e) => `<li><a href="${urlPath}${encodeURIComponent(e.name)}${e.isDirectory() ? '/' : ''}">${e.name}${e.isDirectory() ? '/' : ''}</a></li>`).join('')
  return new Response(`<!doctype html><meta charset="utf-8"><title>${urlPath}</title><style>body{font:16px/1.6 system-ui;max-width:760px;margin:40px auto;padding:0 16px;color:#00123b}a{color:#7758d2}</style><h1>${urlPath}</h1><p><a href="/">← demo</a> · <a href="/bench/">benchmark</a> · <a href="/source/">source</a></p><ul>${items}</ul>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

/** Serves a directory under ROOT read-only, refusing anything outside it or hidden. */
async function tree(prefix: string, base: string, pathname: string, asSource: boolean): Promise<Response> {
  const rel = decodeURIComponent(pathname.slice(prefix.length))
  const target = normalize(join(base, rel))
  if (relative(base, target).startsWith('..') || HIDDEN.test(relative(ROOT, target))) return new Response('Not found', { status: 404 })
  const info = await stat(target).catch(() => null)
  if (!info) return new Response('Not found', { status: 404 })
  if (info.isDirectory()) {
    if (!pathname.endsWith('/')) return Response.redirect(pathname + '/', 301)
    const index = await file(join(target, 'index.html'))
    return index && !asSource ? index : listing(target, pathname)
  }
  return (await file(target, asSource)) ?? new Response('Not found', { status: 404 })
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url)
    const { pathname } = url

    if (pathname === '/api/circle') {
      const handle = cleanHandle(url.searchParams.get('handle') ?? '')
      if (!handle) return json({ error: 'bad_handle' }, 400)
      const wait = allow('circle', clientIp(req, srv), CIRCLES_PER_IP, 15 * 60_000)
      if (wait !== null) return json({ error: 'rate_limited', retryAfter: wait }, 429, { 'Retry-After': String(wait) })
      return stream(async (write, signal) => {
        await harvest(handle, { base: BASE, key: KEY, signal, ...DEFAULTS }, (event: HarvestEvent) => {
          if (event.type === 'done') console.log(`circle @${handle}: ${event.posts} posts + ${event.mentions} mentions (${event.mentionsSource}) ${JSON.stringify(event.timings)}`)
          if (event.type === 'error') console.log(`circle @${handle}: error ${event.code} ${event.detail ?? ''}`)
          write(event)
        })
      }, req.signal)
    }

    if (pathname === '/api/profiles') {
      const handles = (url.searchParams.get('handles') ?? '').split(',').map((h) => cleanHandle(h)).filter((h): h is string => Boolean(h)).slice(0, 60)
      if (!handles.length) return json({ error: 'bad_handle' }, 400)
      const wait = allow('profiles', clientIp(req, srv), 60, 15 * 60_000)
      if (wait !== null) return json({ error: 'rate_limited', retryAfter: wait }, 429, { 'Retry-After': String(wait) })
      const started = performance.now()
      return stream(async (write, signal) => {
        const { resolved, slowestMs } = await resolveProfiles(handles, { base: BASE, key: KEY, signal }, write)
        console.log(`profiles: ${resolved}/${handles.length} in ${Math.round(performance.now() - started)} ms (slowest ${slowestMs} ms)`)
      }, req.signal)
    }

    if (pathname === '/app.js') return new Response(clientJs, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' } })
    if (pathname === '/bench' || pathname.startsWith('/bench/')) return tree('/bench/', join(ROOT, 'bench'), pathname === '/bench' ? '/bench' : pathname, false)
    if (pathname === '/source' || pathname.startsWith('/source/')) return tree('/source/', ROOT, pathname === '/source' ? '/source' : pathname, true)
    if (pathname === '/' || pathname === '/index.html') return (await file(join(ROOT, 'public/index.html')))!
    const asset = await file(normalize(join(ROOT, 'public', pathname)))
    if (asset && !relative(join(ROOT, 'public'), normalize(join(ROOT, 'public', pathname))).startsWith('..')) return asset
    return new Response('Not found', { status: 404 })
  },
})

console.log(`x-circle-fast listening on http://localhost:${server.port} (x.md at ${BASE})`)
