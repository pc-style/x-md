/** Public API integration/benchmark. Run on your server: X_MD_API_KEY=… bun scripts/circle-benchmark.ts handle [...handles]. Never ship the key to a browser. */
import { writeFile } from 'node:fs/promises'
import type { FxTweet, FxAuthor } from '../lib/fxtwitter.js'

const base = new URL(process.env.X_MD_BASE_URL ?? 'https://mdfromx.com')
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
  throw new Error('X_MD_BASE_URL must use HTTPS unless it targets loopback.')
}
const key = process.env.X_MD_API_KEY
if (!key) throw new Error('Set the server-only X_MD_API_KEY environment variable.')
const fresh = process.argv.includes('--fresh')
const handles = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const weights = { reply: 3, quote: 2.5, mention: 1.5, repost: 1 }
type Kind = keyof typeof weights
type Interaction = { id: string; handle: string; direction: 'in' | 'out'; kind: Kind; at: number; profile?: FxAuthor }
type Body = { profile?: FxAuthor; posts?: FxTweet[]; nextCursor?: string; warnings?: string[]; degraded?: boolean; code?: string; retry_after?: number; meta?: { truncated?: boolean; warnings?: string[]; floor_reached?: boolean; count?: number; archive?: { served: number; added: number }; pages?: number } }

class ApiFailure extends Error {
  constructor(readonly status: number, code: string, readonly retryAt: number) { super(`${status}:${code}`) }
}
let searchBlockedUntil = 0

async function circle(handle: string) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Invalid handle')
  const started = performance.now(), until = new Date(process.env.X_MD_UNTIL ?? Date.now()), since = new Date(+until - 120 * 86400_000)
  const requests: Array<{ path: string; status: number; ms: number; retry: number; malformed?: boolean }> = []
  const issues: string[] = [], interactions = new Map<string, Interaction>()
  const self = handle.toLowerCase()
  async function get(path: string, params: Record<string, string> = {}, retry = true): Promise<Body> {
    const url = new URL(path, base)
    for (const [name, value] of Object.entries({ format: 'json', ...(fresh && !path.endsWith('/posts') ? { nocache: 'true' } : {}), ...params })) url.searchParams.set(name, value)
    for (let attempt = 0; ; attempt++) {
      const start = performance.now()
      let response: Response
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(125_000) })
      } catch (error) {
        requests.push({ path, status: 0, ms: Math.round(performance.now() - start), retry: attempt })
        throw error
      }
      const parsed: unknown = await response.json().catch(() => null)
      const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Body : {}
      const expectsProfile = path.startsWith('/api/v1/profiles/') && !path.endsWith('/posts')
      const valid = expectsProfile
        ? typeof body.profile?.screen_name === 'string'
        : Array.isArray(body.posts) && body.posts.every(post => post && typeof post.id === 'string') && (!path.endsWith('/posts') || typeof body.meta?.count === 'number')
      const malformed = response.ok && !valid
      requests.push({ path, status: response.status, ms: Math.round(performance.now() - start), retry: attempt, ...(malformed ? { malformed } : {}) })
      if (response.ok && valid && !body.degraded) return body
      const header = response.headers.get('retry-after')
      const delay = header && /^\d+$/.test(header) ? Number(header) : header ? Math.max(1, Math.ceil((Date.parse(header) - Date.now()) / 1000)) : body.retry_after ?? 30
      const waitSeconds = Number.isFinite(delay) && delay >= 0 ? delay : 30
      if (!retry || attempt >= 2 || (!malformed && ![429, 502, 503].includes(response.status))) throw new ApiFailure(response.status, malformed ? 'invalid_response' : body.code ?? 'degraded', Date.now() + waitSeconds * 1000)
      await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000 + 250 + Math.random() * 500))
    }
  }
  const add = (post: FxTweet, other: string | undefined, direction: 'in' | 'out', kind: Kind, profile?: FxAuthor) => {
    if (!post.id || !other || other.toLowerCase() === self) return
    const at = post.created_timestamp ?? Date.parse(post.created_at ?? '') / 1000
    if (!Number.isFinite(at) || at < +since / 1000 || at > +until / 1000) return
    const item = { id: post.id, handle: other, direction, kind, at, profile }
    interactions.set(`${post.id}:${other.toLowerCase()}:${direction}:${kind}`, item)
  }
  const mentions = (post: FxTweet) => post.raw_text?.facets?.filter(f => f.type === 'mention' && (f.indices?.[0] ?? 0) >= (post.raw_text?.display_text_range?.[0] ?? 0)).map(f => f.original.replace(/^@/, '')) ?? []
  const replyTo = (post: FxTweet) => Array.isArray(post.replying_to) ? post.replying_to[0] : post.replying_to?.screen_name
  function incoming(post: FxTweet) {
    const other = post.author?.screen_name
    if (!other || other.toLowerCase() === self || post.reposted_by) return
    if (replyTo(post)?.toLowerCase() === self) add(post, other, 'in', 'reply', post.author)
    else if (post.quote?.author?.screen_name?.toLowerCase() === self) add(post, other, 'in', 'quote', post.author)
    else if (mentions(post).some(name => name.toLowerCase() === self)) add(post, other, 'in', 'mention', post.author)
  }
  let searchPages = 0, searchComplete = false, mentionSource = 'search', searchStop = 'page_limit'
  let searchResumeCursor: string | undefined
  const mentionIds = new Set<string>()
  const searchOptions: Record<string, string> = { q: `(@${handle} OR to:${handle})`, feed: 'latest', since: since.toISOString(), until: until.toISOString(), limit: '100', require_live: 'true', format: 'json', ...(fresh ? { nocache: 'true' } : {}) }
  const search = async () => {
    if (Date.now() < searchBlockedUntil) { issues.push('search:deferred'); searchStop = 'deferred'; return }
    let cursor: string | undefined
    const seen = new Set<string>()
    for (; searchPages < 10;) {
      const result = await get('/api/v1/search', { ...searchOptions, ...(cursor ? { cursor } : {}) }, false)
      searchPages++
      for (const post of result.posts ?? []) { if (post.id) mentionIds.add(post.id); incoming(post) }
      if (result.warnings?.length) { issues.push(...result.warnings.map(w => `search:${w}`)); searchStop = 'warning'; break }
      if (!result.posts?.length && result.nextCursor) { issues.push('search:empty_page'); searchStop = 'empty_page'; break }
      if (!result.nextCursor) { searchComplete = true; searchStop = 'exhausted'; searchResumeCursor = undefined; break }
      if (seen.has(result.nextCursor)) { issues.push('search_repeated_cursor'); searchStop = 'repeated_cursor'; break }
      seen.add(result.nextCursor); cursor = result.nextCursor; searchResumeCursor = cursor
    }
    if (searchStop === 'page_limit' && !searchComplete) issues.push('search_page_limit')
  }
  const [own] = await Promise.all([
    get(`/api/v1/profiles/${handle}/posts`, { since: since.toISOString(), until: until.toISOString(), max_posts: '1000', ...(fresh ? { refresh: 'true' } : {}) }),
    search().catch(error => {
      issues.push(`search:${String(error)}`); mentionSource = 'partial_search'; searchStop = 'error'
      if (error instanceof ApiFailure && [429, 502, 503].includes(error.status)) searchBlockedUntil = Math.max(searchBlockedUntil, error.retryAt)
    }),
  ])
  const identity = own.profile ? { profile: own.profile } : await get(`/api/v1/profiles/${handle}`, { include_posts: 'false' })
  const ownPosts = own.posts ?? []
  if (own.meta?.truncated || own.meta?.warnings?.length) issues.push('own_posts_partial')
  for (const post of ownPosts) {
    if (post.reposted_by?.screen_name?.toLowerCase() === self) { add(post, post.author?.screen_name, 'out', 'repost', post.author); continue }
    if (post.author?.screen_name?.toLowerCase() !== self) continue
    const parent = replyTo(post)
    add(post, parent, 'out', 'reply')
    add(post, post.quote?.author?.screen_name, 'out', 'quote', post.quote?.author)
    for (const name of mentions(post)) if (name.toLowerCase() !== parent?.toLowerCase()) add(post, name, 'out', 'mention')
  }
  { // Search indexing omits replies even when pagination exhausts; supplement both paths.
    const outgoing = new Map<string, number>()
    for (const event of interactions.values()) if (event.direction === 'out') {
      const name = event.handle.toLowerCase(); outgoing.set(name, (outgoing.get(name) ?? 0) + 1)
    }
    const frequent = new Set([...outgoing].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name]) => name))
    const priority = (post: FxTweet) => { const target = replyTo(post)?.toLowerCase(); return target && target !== self ? frequent.has(target) ? 0 : 2 : 1 }
    const candidates = [...new Map(ownPosts.filter(p => p.id && p.replies && p.author?.screen_name?.toLowerCase() === self).map(p => [p.id, p])).values()]
      .sort((a, b) => priority(a) - priority(b) || (b.created_timestamp ?? Date.parse(b.created_at ?? '') / 1000) - (a.created_timestamp ?? Date.parse(a.created_at ?? '') / 1000)).slice(0, 80)
    const queue = [...candidates]
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length) { const post = queue.shift()!; try { const result = await get(`/api/v1/posts/${post.id}/replies`, { limit: '100' }); for (const reply of result.posts ?? []) { if (reply.id) mentionIds.add(reply.id); incoming(reply) } } catch { issues.push('reply_sample_failed') } }
    }))
    mentionSource = searchPages > 0 ? 'search_and_reply_sample' : 'reply_sample'
  }
  const scores = new Map<string, { handle: string; a: number; b: number; profile?: FxAuthor; events: number }>()
  for (const event of interactions.values()) {
    const h = event.handle.toLowerCase(), score = scores.get(h) ?? { handle: event.handle, a: 0, b: 0, events: 0 }
    const value = weights[event.kind] * 0.5 ** (Math.max(0, +until / 1000 - event.at) / 86400 / 30)
    if (event.direction === 'out') score.a += value; else score.b += value
    score.events++; if (event.profile?.avatar_url) score.profile = event.profile
    scores.set(h, score)
  }
  const ranked = [...scores.values()].map(s => ({ ...s, score: s.a + s.b + 2 * Math.sqrt(s.a * s.b) })).sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
  const missing = ranked.slice(0, 50).filter(s => !s.profile?.avatar_url)
  await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
    while (missing.length) { const member = missing.shift()!; try { member.profile = (await get(`/api/v1/profiles/${member.handle}`, { include_posts: 'false' })).profile } catch { issues.push('profile_missing') } }
  }))
  const wall_ms = Math.round(performance.now() - started)
  const events = [...interactions.values()], incomingCount = events.filter(e => e.direction === 'in').length
  const uniquePosts = new Set([...ownPosts.map(post => post.id), ...mentionIds].filter(Boolean)).size
  const summary = { handle, fresh, since: since.toISOString(), until: until.toISOString(), wall_ms, own_posts: ownPosts.length, incoming_posts: mentionIds.size, incoming_interactions: incomingCount, interactions: events.length, members: ranked.length, avatars: ranked.slice(0, 50).filter(s => s.profile?.avatar_url).length, unique_posts: uniquePosts, posts_per_second: Number((uniquePosts / (wall_ms / 1000)).toFixed(2)), search_pages: searchPages, search_complete: searchComplete, search_stop: searchStop, search_retry_at: !searchComplete && searchBlockedUntil > Date.now() ? new Date(searchBlockedUntil).toISOString() : undefined, search_resume: searchComplete ? undefined : { ...searchOptions, ...(searchResumeCursor ? { cursor: searchResumeCursor } : {}) }, mention_source: mentionSource, issues: [...new Set(issues)], requests: requests.length, failures: requests.filter(r => r.status === 0 || r.status >= 400 || r.malformed).length, retries: requests.filter(r => r.retry > 0).length, own_meta: own.meta, top20: ranked.slice(0, 20).map(s => s.handle) }
  if (process.env.X_MD_EVIDENCE_DIR) await writeFile(`${process.env.X_MD_EVIDENCE_DIR}/circle-${handle}-${Date.now()}.json`, JSON.stringify({ summary, requests, interactions: events, ranked, owner: identity.profile }))
  console.log(JSON.stringify(summary))
}
for (const handle of handles) await circle(handle)
