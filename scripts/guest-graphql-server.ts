/**
 * Standalone server for the guest GraphQL prototype (lib/guest-graphql.ts),
 * so the method can be timed and compared from outside the Vercel app.
 *
 *   X_GUEST_BEARER=… PORT=4317 bun scripts/guest-graphql-server.ts
 *
 * GET /post/:id?thread=parents|off   the post (+ parents), as fetchPosts' tweets
 * GET /user/:handle?count=20         the profile and its guest timeline
 * GET /health                        token pool size, never token values
 *
 * Every answer is JSON with a `timing` block: total milliseconds and each
 * upstream round trip (operation, status, ms, pool slot).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { ConvertError } from '../lib/errors.js'
import {
  fetchGuestPosts,
  fetchGuestProfile,
  fetchGuestProfileStatuses,
  GUEST_MAX_PARENTS,
  guestPoolStats,
  type GuestTrace,
} from '../lib/guest-graphql.js'

const PORT = Number(process.env.PORT) || 4317
const HOST = process.env.HOST ?? '127.0.0.1'
/** Every read goes out from this one machine's IP; keep any one caller from spending it. */
const PER_IP_PER_MINUTE = 30
const hits = new Map<string, number[]>()

function limited(ip: string): number | undefined {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < 60_000)
  if (recent.length >= PER_IP_PER_MINUTE) return Math.ceil((recent[0] + 60_000 - now) / 1000)
  recent.push(now)
  hits.set(ip, recent)
  if (hits.size > 10_000) hits.clear()
  return undefined
}

interface Reply { status: number; body: unknown; headers?: Record<string, string> }

function send(res: ServerResponse, { status, body, headers = {} }: Reply): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers })
  res.end(JSON.stringify(body, null, 2))
}

function timing(started: number, trace: GuestTrace) {
  return { total_ms: Math.round(performance.now() - started), upstream_calls: trace.length, upstream: trace, guest_pool: guestPoolStats() }
}

const INDEX = {
  method: 'guest-graphql',
  description: "Prototype: X's web GraphQL read logged out with rotating guest tokens. No accounts. Output uses the x-md fetcher's post and profile shapes.",
  endpoints: {
    'GET /post/:id': `the post, plus up to ${GUEST_MAX_PARENTS} reply parents (?thread=off for the post alone)`,
    'GET /user/:handle': 'the profile and posts from its guest timeline (?count=1-100, default 20; ?cursor= for the next page)',
    'GET /health': 'guest token pool size',
  },
  limits: [
    'Guests cannot read TweetDetail: no thread continuation below the post and no replies.',
    "A guest UserTweets is X's logged-out highlights, not the latest posts, and is empty for some smaller accounts. Returned newest first.",
    'Posts X hides from logged-out viewers (sensitive media, protected or suspended accounts) answer 404.',
    `${PER_IP_PER_MINUTE} requests per minute per IP.`,
  ],
}

async function route(url: URL, trace: GuestTrace): Promise<{ status: number; body: unknown }> {
  const post = url.pathname.match(/^\/post\/(\d{1,25})\/?$/)
  if (post) {
    const thread = url.searchParams.get('thread') === 'off' ? 'off' : 'parents'
    return { status: 200, body: await fetchGuestPosts(post[1], thread, trace) }
  }
  const user = url.pathname.match(/^\/user\/@?([A-Za-z0-9_]{1,15})\/?$/)
  if (user) {
    const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 20, 1), 100)
    const profile = await fetchGuestProfile(user[1], trace)
    const posts = await fetchGuestProfileStatuses(profile.id ?? '', count, url.searchParams.get('cursor') ?? undefined, trace)
    return { status: 200, body: { profile, posts: { ...posts, ordering: 'guest highlights, newest first' } } }
  }
  return { status: 404, body: { error: { code: 'not_found', message: 'Unknown route.' }, ...INDEX } }
}

async function handle(req: IncomingMessage): Promise<Reply> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, body: { error: { code: 'method_not_allowed', message: 'GET only.' } }, headers: { allow: 'GET, HEAD' } }
  if (url.pathname === '/') return { status: 200, body: INDEX }
  if (url.pathname === '/health') return { status: 200, body: { ok: true, guest_pool: guestPoolStats() } }

  const forwarded = req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for']
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'local'
  const wait = limited(ip)
  if (wait) return { status: 429, body: { error: { code: 'rate_limited', message: `Limit is ${PER_IP_PER_MINUTE} requests per minute.` } }, headers: { 'retry-after': String(wait) } }

  const started = performance.now()
  const trace: GuestTrace = []
  try {
    const { status, body } = await route(url, trace)
    return { status, body: status < 400 ? { data: body, timing: timing(started, trace) } : { ...body as object, timing: timing(started, trace) } }
  } catch (error) {
    const known = error instanceof ConvertError
    if (!known) console.error(error)
    return {
      status: known ? error.status : 500,
      body: {
        error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Unexpected error.', retry_after: known ? error.retryAfter : undefined },
        timing: timing(started, trace),
      },
    }
  }
}

createServer((req, res) => {
  const started = performance.now()
  void handle(req).then((reply) => {
    send(res, reply)
    console.log(`${req.method} ${new URL(req.url ?? '/', 'http://localhost').pathname} ${reply.status} ${Math.round(performance.now() - started)}ms`)
  })
}).listen(PORT, HOST, () => console.log(`guest-graphql prototype on http://${HOST}:${PORT}`))
