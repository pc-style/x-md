/**
 * x-md's fetcher on Cloudflare Workers, with the self-hosted FxEmbed fork
 * (`xmd-fx`) as its only FxTwitter base instead of the public api.fxtwitter.com
 * pool. The fetcher's syndication fallback for posts stays, as in production;
 * `source` says which one served.
 *
 *   GET /post/:id        fetchPosts() output (thread=full|off, replies=off|top|recent)
 *   GET /user/:handle    fetchFxProfile() + fetchFxProfileStatuses() (count, replies=true, cursor)
 *
 * Every response carries `timing`: total ms and each upstream call (host, path, status, ms).
 * No credentials live here; the fork holds its own X accounts as Worker secrets.
 * `FXTWITTER_BASE_URL` comes from wrangler.toml, and nodejs_compat puts it in
 * process.env before lib/fxtwitter.ts reads it at import.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { fetchPosts } from '../../lib/tweet-fetch.js'
import { fetchFxProfile, fetchFxProfileStatuses, FX_BASES } from '../../lib/fxtwitter.js'
import { ConvertError } from '../../lib/errors.js'

interface Env {
  /** Service binding to the fork; same-account workers.dev URLs are not reachable by plain fetch. */
  FX?: { fetch: typeof fetch }
}

interface Call { host: string; path: string; status: number | null; ms: number }
const calls = new AsyncLocalStorage<Call[]>()
const realFetch = globalThis.fetch.bind(globalThis)
const forkHosts = new Set(FX_BASES.map((base) => new URL(base).host))
let binding: Env['FX']

globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const send = binding && forkHosts.has(url.host) ? binding.fetch.bind(binding) : realFetch
  const started = performance.now()
  const log = calls.getStore()
  try {
    const response = await send(input, init)
    log?.push({ host: url.host, path: url.pathname + url.search, status: response.status, ms: Math.round(performance.now() - started) })
    return response
  } catch (error) {
    log?.push({ host: url.host, path: url.pathname + url.search, status: null, ms: Math.round(performance.now() - started) })
    throw error
  }
}, realFetch)

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', ...headers },
  })

async function timed(run: () => Promise<Record<string, unknown>>): Promise<Response> {
  const log: Call[] = []
  const started = performance.now()
  try {
    const body = await calls.run(log, run)
    return json(200, { ...body, timing: { total_ms: Math.round(performance.now() - started), upstream: log } })
  } catch (error) {
    const timing = { total_ms: Math.round(performance.now() - started), upstream: log }
    if (error instanceof ConvertError) {
      return json(error.status, { error: { code: error.code, message: error.message, retry_after: error.retryAfter }, timing },
        error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {})
    }
    return json(500, { error: { code: 'internal', message: 'Unexpected failure.' }, timing })
  }
}

async function route(method: string, url: URL): Promise<Response> {
  if (method !== 'GET') return json(405, { error: { code: 'method_not_allowed' } })
  const q = url.searchParams

  const post = url.pathname.match(/^\/post\/(\d{1,20})\/?$/)
  if (post) {
    const thread = q.get('thread') === 'off' ? 'off' : 'full'
    const replies = (['top', 'recent'] as const).find((mode) => mode === q.get('replies')) ?? 'off'
    return timed(async () => {
      // The handle only seeds the syndication fallback; `source` shows when it served.
      const result = await fetchPosts('i', post[1], thread, 'full', replies)
      return { source: result.source, posts: result.tweets }
    })
  }

  const user = url.pathname.match(/^\/user\/([A-Za-z0-9_]{1,15})\/?$/)
  if (user) {
    const count = Math.min(100, Math.max(1, Number(q.get('count')) || 20))
    return timed(async () => {
      const profile = fetchFxProfile(user[1])
      const statuses = fetchFxProfileStatuses(user[1], q.get('cursor') ?? undefined, count, { withReplies: q.get('replies') === 'true', retries: 2 })
      // The profile decides a missing account; the timeline alone only ever says "retry".
      void statuses.catch(() => {})
      const author = await profile
      const page = await statuses
      return { source: 'fxtwitter', user: author, posts: page.results, cursor: page.cursor ?? null, attempts: page.attempts }
    })
  }

  if (url.pathname === '/') {
    return json(200, {
      name: 'x-md fetcher on Workers, self-hosted FxEmbed upstream',
      routes: ['GET /post/:id?thread=full|off&replies=off|top|recent', 'GET /user/:handle?count=20&replies=false&cursor='],
      example: ['/post/20', '/user/jack'],
    })
  }
  return json(404, { error: { code: 'not_found', message: 'Try /post/:id or /user/:handle.' } })
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    binding ??= env.FX
    return route(request.method, new URL(request.url))
  },
}
