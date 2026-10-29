/**
 * Prototype: X syndication (cdn.syndication.twimg.com/tweet-result) as the
 * primary source for single posts, behind the shape the current fetcher
 * returns. Not wired into the app; run it on its own:
 *
 *   PORT=4780 bun scripts/syndication-proto.ts
 *
 * GET /post/:id            { tweets, source, timing }; ?thread=full walks the parent chain
 * GET /user/:handle        { resource: 'profile', profile, posts, source, degraded, timing }
 *
 * Syndication has no profile or timeline read that works without a login
 * (timeline-profile answers 429), so /user tries it once and then degrades to
 * FxTwitter, saying so in `degraded` and `notes`.
 */
import { createServer } from 'node:http'
import { ConvertError } from '../lib/errors.js'
import { fetchFxProfile, fetchFxProfileStatuses, fetchFxStatus, type FxAuthor, type FxTweet } from '../lib/fxtwitter.js'
import { fetchSyndicationChain, fetchSyndicationStatus } from '../lib/syndication.js'

interface Step { source: string; ms: number; ok: boolean; error?: string }

async function timed<T>(steps: Step[], source: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    const value = await run()
    steps.push({ source, ms: Math.round(performance.now() - started), ok: true })
    return value
  } catch (error) {
    steps.push({ source, ms: Math.round(performance.now() - started), ok: false, error: publicError(error) })
    throw error
  }
}

function publicError(error: unknown): string {
  if (error instanceof ConvertError) return error.code ?? `http_${error.status}`
  if (error instanceof Error && error.name === 'TimeoutError') return 'timeout'
  return 'upstream_error'
}

function withContext(chain: FxTweet[], id: string): FxTweet[] {
  const focal = chain.findIndex((tweet) => tweet.id === id)
  return chain.map((tweet, index) => ({ ...tweet, context: index === focal ? 'post' : index < focal ? 'parent' : 'thread' }))
}

async function post(id: string, thread: boolean) {
  const steps: Step[] = []
  const notes: string[] = []
  try {
    const tweets = thread
      ? await timed(steps, 'syndication', () => fetchSyndicationChain('', id, 10, AbortSignal.timeout(8000)))
      : [await timed(steps, 'syndication', () => fetchSyndicationStatus('', id, AbortSignal.timeout(4000)))]
    if (thread) notes.push('Syndication walks up to parents only; later self-thread posts and replies are not reachable.')
    return { status: 200, body: { tweets: withContext(tweets, id), source: 'syndication', notes, steps } }
  } catch (error) {
    if (error instanceof ConvertError && error.status === 404 && error.code === 'syndication_error') {
      return { status: 404, body: { error: 'not_found', source: 'syndication', steps } }
    }
  }
  try {
    const tweet = await timed(steps, 'fxtwitter', () => fetchFxStatus(id))
    notes.push('Syndication failed; served by the FxTwitter fallback.')
    return { status: 200, body: { tweets: withContext([tweet], id), source: 'fxtwitter', degraded: true, notes, steps } }
  } catch (error) {
    const status = error instanceof ConvertError ? error.status : 502
    return { status, body: { error: publicError(error), steps } }
  }
}

interface NextTimelineEntry { content?: { tweet?: Record<string, unknown> } }

/** Best effort: the embed timeline's __NEXT_DATA__, when X serves it. */
async function syndicationTimeline(handle: string): Promise<FxTweet[]> {
  const response = await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; x-md/1.0)' },
    signal: AbortSignal.timeout(3000),
  })
  if (!response.ok) throw new ConvertError(response.status === 429 ? 429 : 502, 'Syndication timeline unavailable.', `syndication_timeline_${response.status}`)
  const html = await response.text()
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/)
  const entries = (match ? JSON.parse(match[1])?.props?.pageProps?.timeline?.entries : undefined) as NextTimelineEntry[] | undefined
  if (!entries?.length) throw new ConvertError(502, 'Syndication timeline was empty.', 'syndication_timeline_empty')
  return entries.flatMap((entry) => {
    const tweet = entry.content?.tweet as { id_str?: string; text?: string; created_at?: string; favorite_count?: number; user?: { screen_name?: string; name?: string } } | undefined
    if (!tweet?.id_str) return []
    return [{
      id: tweet.id_str,
      text: tweet.text,
      created_at: tweet.created_at,
      likes: tweet.favorite_count,
      url: `https://x.com/${tweet.user?.screen_name ?? handle}/status/${tweet.id_str}`,
      author: { screen_name: tweet.user?.screen_name, name: tweet.user?.name },
    }]
  })
}

async function user(handle: string, limit: number) {
  const steps: Step[] = []
  const notes: string[] = []
  let posts: FxTweet[] | undefined
  try {
    posts = (await timed(steps, 'syndication_timeline', () => syndicationTimeline(handle))).slice(0, limit)
  } catch {
    notes.push('Syndication has no anonymous profile read: timeline-profile was refused, so FxTwitter served this profile.')
  }
  try {
    const [profile, statuses] = await Promise.all([
      timed(steps, 'fxtwitter_profile', () => fetchFxProfile(handle, AbortSignal.timeout(8000))) as Promise<FxAuthor>,
      posts ? Promise.resolve(undefined) : timed(steps, 'fxtwitter_statuses', () => fetchFxProfileStatuses(handle, undefined, limit, { retries: 1, signal: AbortSignal.timeout(8000) })),
    ])
    return {
      status: 200,
      body: {
        resource: 'profile',
        handle,
        profile,
        posts: posts ?? statuses?.results.slice(0, limit) ?? [],
        source: posts ? 'syndication' : 'fxtwitter',
        degraded: !posts,
        notes,
        steps,
      },
    }
  } catch (error) {
    const status = error instanceof ConvertError ? error.status : 502
    return { status, body: { error: publicError(error), notes, steps } }
  }
}

const INDEX = {
  name: 'x-md syndication prototype',
  routes: {
    'GET /post/:id': 'syndication tweet-result first, FxTwitter on failure. ?thread=full walks the parent chain.',
    'GET /user/:handle': 'profile and recent posts (?limit=1-40, default 20). Syndication cannot serve profiles; see notes.',
  },
  examples: ['/post/2115687168697880921?thread=full', '/post/2089772419175047410', '/user/jack'],
}

async function route(url: URL): Promise<{ status: number; body: Record<string, unknown> }> {
  const postMatch = url.pathname.match(/^\/post\/(\d{1,20})\/?$/)
  const userMatch = url.pathname.match(/^\/user\/@?([A-Za-z0-9_]{1,15})\/?$/)
  if (url.pathname === '/') return { status: 200, body: INDEX }
  if (postMatch) return post(postMatch[1], url.searchParams.get('thread') === 'full')
  if (userMatch) {
    const limit = Math.min(40, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20))
    return user(userMatch[1], limit)
  }
  return { status: 404, body: { error: 'not_found', routes: Object.keys(INDEX.routes) } }
}

createServer(async (request, response) => {
  const started = performance.now()
  const url = new URL(request.url ?? '/', 'http://localhost')
  const result = request.method === 'GET' ? await route(url) : { status: 405, body: { error: 'method_not_allowed' } }
  const { steps, ...rest } = result.body
  const total = Math.round(performance.now() - started)
  response.writeHead(result.status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'server-timing': `total;dur=${total}`,
  })
  response.end(JSON.stringify({ ...rest, timing: { total_ms: total, steps } }, null, 2))
}).listen(Number(process.env.PORT ?? 4780))
