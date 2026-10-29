/**
 * Prototype: read posts and profiles straight from X's web GraphQL (TweetDetail,
 * UserByScreenName, UserTweets) with our own logged-in sessions, rotating
 * across them, and return the same FxTweet/FxAuthor shapes the FxTwitter
 * fetcher produces. A standalone server, not wired into the app.
 *
 *   X_SEARCH_SESSIONS_JSON='[...]' bun scripts/x-session-graphql-proto.ts
 *
 *   GET /post/:id                 focal post, quote, media, and the thread around it
 *   GET /user/:handle?count=N     profile plus up to N (max 20) recent posts
 *   GET /health                   session pool state (counts only)
 *
 * Sessions load the same way as lib/xsearch.ts (`accounts.local.json` in the
 * working directory, else `X_SEARCH_SESSIONS_JSON`). Cookies never leave this
 * process: responses and logs name a session by its pool index only, and
 * upstream error bodies are reduced to a status code.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer } from 'node:http'
import { ApiError, AuthenticationError, Scraper, type Tweet } from '@the-convocation/twitter-scraper'
import type { FxTweet } from '../lib/fxtwitter.js'
import { loadXSessions, profileToFx, tweetToFx, type XSession } from '../lib/xsearch.js'

const PORT = Number(process.env.PORT ?? 4817)
const REQUEST_TIMEOUT_MS = 12_000
const WINDOW_MS = 15 * 60_000
/** Our own ceiling per session per endpoint, well under X's per-account limits. */
const SESSION_BUDGET = 40
const TRANSIENT_COOLDOWN_MS = 30_000
/** The endpoint is public and spends real accounts, so callers are metered too. */
const IP_BUDGET = 30
const CACHE_MS = 60_000
const MAX_ATTEMPTS = 3

interface Slot {
  index: number
  session: XSession
  scraper?: Scraper
  coolUntil: number
  disabled?: string
  used: Map<string, number[]>
}

interface Call { endpoint: string; session: string; status: number | 'error'; ms: number }
const calls = new AsyncLocalStorage<Call[]>()
const currentSlot = new AsyncLocalStorage<Slot>()

const slots: Slot[] = loadXSessions().map((session, index) => ({ index, session, coolUntil: 0, used: new Map() }))
let rotation = 0

function endpointOf(input: RequestInfo | URL): string {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  return /\/graphql\/[^/]+\/([A-Za-z]+)/.exec(url)?.[1] ?? new URL(url).pathname
}

async function scraperFor(slot: Slot): Promise<Scraper> {
  if (slot.scraper) return slot.scraper
  const scraper = new Scraper({
    fetch: async (input, init) => {
      const started = performance.now()
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
      const call: Call = { endpoint: endpointOf(input), session: `s${slot.index}`, status: 'error', ms: 0 }
      calls.getStore()?.push(call)
      try {
        const response = await fetch(input, { ...init, signal })
        call.status = response.status
        if (response.status === 429) {
          const reset = Number(response.headers.get('x-rate-limit-reset'))
          slot.coolUntil = Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + WINDOW_MS
        }
        return response
      } finally {
        call.ms = Math.round(performance.now() - started)
      }
    },
  })
  // Resolves only once the user auth is in place; before that the scraper is a guest.
  await scraper.setCookies([
    `auth_token=${slot.session.authToken}; Domain=.x.com; Path=/; Secure; HttpOnly`,
    `ct0=${slot.session.ct0}; Domain=.x.com; Path=/; Secure`,
  ])
  slot.scraper = scraper
  return scraper
}

/** Spend one unit of a slot's per-endpoint budget; false when the window is full. */
function spend(slot: Slot, endpoint: string, units = 1): boolean {
  const now = Date.now()
  const recent = (slot.used.get(endpoint) ?? []).filter((at) => at > now - WINDOW_MS)
  if (recent.length + units > SESSION_BUDGET) return false
  for (let i = 0; i < units; i += 1) recent.push(now)
  slot.used.set(endpoint, recent)
  return true
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfter?: number
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

function failureOf(error: unknown): { kind: 'rate_limit' | 'auth' | 'transient'; detail: string } {
  if (error instanceof AuthenticationError) return { kind: 'auth', detail: 'authentication' }
  if (error instanceof ApiError) {
    const status = error.response.status
    if (status === 429) return { kind: 'rate_limit', detail: 'HTTP 429' }
    if (status === 401 || status === 403) return { kind: 'auth', detail: `HTTP ${status}` }
    return { kind: 'transient', detail: `HTTP ${status}` }
  }
  return { kind: 'transient', detail: error instanceof Error ? error.name : 'error' }
}

/** Run `work` on the next healthy session; a failed session sits out and the next one tries. */
async function withSession<T>(endpoints: string[], work: (scraper: Scraper) => Promise<T>): Promise<T> {
  let attempts = 0
  for (let i = 0; i < slots.length && attempts < MAX_ATTEMPTS; i += 1) {
    const slot = slots[(rotation + i) % slots.length]
    if (slot.disabled || slot.coolUntil > Date.now()) continue
    if (!endpoints.every((endpoint) => spend(slot, endpoint))) continue
    rotation = (rotation + i + 1) % slots.length
    try {
      const scraper = await scraperFor(slot)
      return await currentSlot.run(slot, () => work(scraper))
    } catch (error) {
      if (error instanceof HttpError) throw error
      const failure = failureOf(error)
      // A dead session is the pool's problem, not this request's: it does not use up an attempt.
      if (failure.kind === 'auth') {
        slot.disabled = failure.detail
      } else {
        attempts += 1
        const cooldown = failure.kind === 'transient' ? TRANSIENT_COOLDOWN_MS : WINDOW_MS
        slot.coolUntil = Math.max(slot.coolUntil, Date.now() + cooldown)
      }
      console.warn(`[proto] s${slot.index} ${failure.kind}: ${failure.detail}`)
    }
  }
  const nextFree = Math.min(...slots.filter((slot) => !slot.disabled).map((slot) => slot.coolUntil))
  const retryAfter = Number.isFinite(nextFree) ? Math.max(1, Math.ceil((nextFree - Date.now()) / 1000)) : undefined
  throw new HttpError(503, 'sessions_unavailable', 'No X session could serve this request. Retry shortly.', retryAfter)
}

function withContext(tweet: Tweet, context: FxTweet['context']): FxTweet {
  return { ...tweetToFx(tweet), context }
}

async function getPost(id: string) {
  return withSession(['TweetDetail'], async (scraper) => {
    const focal = await scraper.getTweet(id)
    if (!focal) throw new HttpError(404, 'not_found', 'Post not found.')
    const parents: FxTweet[] = []
    const seen = new Set([focal.id])
    for (let parent = focal.inReplyToStatus; parent?.id && !seen.has(parent.id); parent = parent.inReplyToStatus) {
      seen.add(parent.id)
      parents.unshift(withContext(parent, 'parent'))
    }
    const followups = focal.thread.filter((tweet) => tweet.id && !seen.has(tweet.id)).map((tweet) => withContext(tweet, 'thread'))
    return {
      status: tweetToFx(focal),
      thread: [...parents, withContext(focal, 'post'), ...followups],
      session: `s${currentSlot.getStore()?.index}`,
    }
  })
}

async function getUser(handle: string, count: number) {
  return withSession(['UserByScreenName', 'UserTweets'], async (scraper) => {
    const profile = await scraper.getProfile(handle).catch((error: unknown) => {
      // The library reports a miss as a plain Error; it says nothing about the session.
      const message = error instanceof Error ? error.message : ''
      if (/User not found|rest_id not found/.test(message)) throw new HttpError(404, 'not_found', 'Profile not found.')
      if (/suspended/i.test(message)) throw new HttpError(404, 'suspended', 'Profile is suspended.')
      throw error
    })
    if (!profile.userId) throw new HttpError(404, 'not_found', 'Profile not found.')
    const posts: FxTweet[] = []
    if (!profile.isPrivate) {
      for await (const tweet of scraper.getTweetsByUserId(profile.userId, count)) {
        posts.push(tweetToFx(tweet))
        if (posts.length >= count) break
      }
    }
    return { user: profileToFx(profile), posts, session: `s${currentSlot.getStore()?.index}` }
  })
}

const ipHits = new Map<string, number[]>()
function ipAllowed(ip: string): { ok: boolean; retryAfter?: number } {
  const now = Date.now()
  const recent = (ipHits.get(ip) ?? []).filter((at) => at > now - WINDOW_MS)
  if (recent.length >= IP_BUDGET) {
    ipHits.set(ip, recent)
    return { ok: false, retryAfter: Math.ceil((recent[0] + WINDOW_MS - now) / 1000) }
  }
  recent.push(now)
  ipHits.set(ip, recent)
  return { ok: true }
}

const cache = new Map<string, { at: number; body: unknown }>()

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store', ...headers },
  })
}

async function handle(request: Request, ip: string): Promise<Response> {
  const started = performance.now()
  const url = new URL(request.url)
  const post = /^\/post\/(\d{1,20})\/?$/.exec(url.pathname)
  const user = /^\/user\/@?([A-Za-z0-9_]{1,15})\/?$/.exec(url.pathname)
  const count = Math.min(20, Math.max(1, Number(url.searchParams.get('count')) || 10))

  if (url.pathname === '/' || url.pathname === '/health') {
    const now = Date.now()
    return json({
      prototype: 'x-session-graphql',
      routes: ['GET /post/:id', 'GET /user/:handle?count=1..20'],
      sessions: {
        total: slots.length,
        disabled: slots.filter((slot) => slot.disabled).length,
        cooling: slots.filter((slot) => !slot.disabled && slot.coolUntil > now).length,
      },
    })
  }
  if (request.method !== 'GET') return json({ error: { code: 'method_not_allowed', message: 'GET only.' } }, 405)
  if (!post && !user) return json({ error: { code: 'not_found', message: 'Use /post/:id or /user/:handle.' } }, 404)

  const key = post ? `post:${post[1]}` : `user:${user![1].toLowerCase()}:${count}`
  const hit = cache.get(key)
  if (hit && hit.at > Date.now() - CACHE_MS) {
    return json({ ...(hit.body as object), timing: { total_ms: Math.round(performance.now() - started), cache: 'hit', age_ms: Date.now() - hit.at, upstream: [] } })
  }

  const allowed = ipAllowed(ip)
  if (!allowed.ok) {
    return json({ error: { code: 'rate_limited', message: `This prototype allows ${IP_BUDGET} uncached requests per IP per 15 minutes.` } }, 429, { 'retry-after': String(allowed.retryAfter) })
  }

  const upstream: Call[] = []
  try {
    const body = await calls.run(upstream, () => (post ? getPost(post[1]) : getUser(user![1], count)))
    cache.set(key, { at: Date.now(), body })
    return json({ ...body, timing: { total_ms: Math.round(performance.now() - started), cache: 'miss', upstream } })
  } catch (error) {
    const timing = { total_ms: Math.round(performance.now() - started), upstream }
    if (error instanceof HttpError) {
      return json({ error: { code: error.code, message: error.message }, timing }, error.status, error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {})
    }
    console.warn(`[proto] ${key} failed: ${error instanceof Error ? error.name : 'error'}`)
    return json({ error: { code: 'upstream_error', message: 'X did not return a usable response.' }, timing }, 502)
  }
}

if (slots.length === 0) throw new Error('No X sessions: set X_SEARCH_SESSIONS_JSON or add accounts.local.json.')

createServer(async (req, res) => {
  const forwarded = req.headers['cf-connecting-ip']
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? req.socket.remoteAddress ?? 'unknown'
  const response = await handle(new Request(`http://localhost${req.url ?? '/'}`, { method: req.method }), ip)
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(await response.text())
}).listen(PORT, '127.0.0.1', () => console.log(`[proto] listening on 127.0.0.1:${PORT} with ${slots.length} sessions`))
