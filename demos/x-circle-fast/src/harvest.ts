import { Collector, incomingInteraction, ownPostInteractions, toPerson, type Interaction, type Person, type RawPost, type RawUser } from './core.ts'

/**
 * Server-side collection against the x.md API. Two streams start at once:
 *
 * - the account's own posts and replies, from one bulk-import request that
 *   x.md walks in parallel and streams back as NDJSON;
 * - posts by others that mention the account, from x.md search, fanned out
 *   over adjacent time windows sized from the first page instead of walking
 *   one cursor at a time.
 *
 * Raw posts never leave the server: they are reduced to interactions here and
 * emitted in small batches, so the browser can rank and redraw as they land.
 */

export type HarvestEvent =
  | { type: 'profile'; profile: Person & { protected: boolean }; t: number }
  | { type: 'batch'; stream: 'posts' | 'mentions'; interactions: Interaction[]; posts: number; mentions: number; oldest: number | null; t: number }
  | { type: 'mentions-source'; source: 'search' | 'replies' | null; detail?: string; t: number }
  | { type: 'done'; posts: number; mentions: number; postsRead: number; oldest: number | null; postsOldest: number | null; mentionsOldest: number | null; mentionsSource: 'search' | 'replies' | null; timings: Record<string, number>; t: number }
  | { type: 'error'; code: 'not_found' | 'private' | 'empty' | 'unavailable' | 'rate_limited'; detail?: string; t: number }

/** What the browser reads from a circle's log: the harvest, plus photos it asked for along the way. */
export type CircleEvent =
  | HarvestEvent
  | { type: 'person'; person: Person }
  | { type: 'profiles-done'; handles: string[] }

export interface HarvestOptions {
  base: string
  key: string
  maxDays: number
  maxPosts: number
  concurrency: number
  /** Most search requests one circle may spend on mentions. */
  searchBudget: number
  /** Own posts whose reply threads are read when search is unavailable. */
  threadBudget: number
  signal: AbortSignal
}

const PROFILE_TIMEOUT_MS = 4000
const THREAD_TIMEOUT_MS = 8000
/** Thread reads are latency-bound (3–5 s each upstream), so the whole budget runs at once. */
const THREAD_CONCURRENCY = 40

export const DEFAULTS = { maxDays: 120, maxPosts: 1000, concurrency: 16, searchBudget: 8, threadBudget: 40 }

class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Remaining units of one policy in an RFC 9651 `RateLimit` header, e.g. `"account-key";r=48;t=175`. */
export function remaining(header: string | null, policy: string): number | null {
  if (!header) return null
  const match = new RegExp(`"${policy}";r=(\\d+)`).exec(header)
  return match ? Number(match[1]) : null
}

async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer)
}

export async function harvest(handle: string, options: HarvestOptions, emit: (event: HarvestEvent) => void): Promise<void> {
  const started = performance.now()
  const t = () => Math.round(performance.now() - started)
  const timings: Record<string, number> = {}
  const mark = (name: string) => { if (timings[name] === undefined) timings[name] = t() }
  const headers = { Authorization: `Bearer ${options.key}`, Accept: 'application/json' }
  const inner = new AbortController()
  const signal = AbortSignal.any([options.signal, inner.signal])
  const get = (path: string, params: Record<string, string | number | undefined>, only = signal) => {
    const url = new URL(path, options.base)
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))
    return fetch(url, { headers, signal: only })
  }

  const now = Date.now() / 1000
  const floor = now - options.maxDays * 86400
  const collector = new Collector(handle)
  let posts = 0
  let mentions = 0
  let postsOldest: number | null = null
  let mentionsOldest: number | null = null
  // Reply threads under the account's own posts, queued as the posts stream in: the
  // source of incoming replies when search is unavailable, as in X Circle.
  const threadQueue: string[] = []
  let threadsQueued = 0
  let postsFinished = false
  const waiters: (() => void)[] = []
  const nudge = () => { for (const wake of waiters.splice(0)) wake() }

  // Coalesce interactions into ~80ms batches: fewer events, same latency to the eye.
  const pending: Record<'posts' | 'mentions', Interaction[]> = { posts: [], mentions: [] }
  const dirty = { posts: false, mentions: false }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    for (const stream of ['posts', 'mentions'] as const) {
      if (!dirty[stream]) continue
      emit({ type: 'batch', stream, interactions: pending[stream], posts, mentions, oldest: stream === 'posts' ? postsOldest : mentionsOldest, t: t() })
      pending[stream] = []
      dirty[stream] = false
    }
  }
  const queue = (stream: 'posts' | 'mentions', items: Interaction[]) => {
    pending[stream].push(...items)
    dirty[stream] = true
    timer ??= setTimeout(flush, 80)
  }

  // The owner's name and photo. Only a 404 is fatal: any other failure leaves the
  // owner to be taken from the first of their own posts in the import.
  let ownerKnown = false
  const announce = (user: RawUser | undefined) => {
    const person = toPerson(user)
    if (ownerKnown || !person) return
    ownerKnown = true
    mark('profile')
    emit({ type: 'profile', profile: { ...person, protected: Boolean(user?.protected) }, t: t() })
  }
  const profileTask = (async () => {
    for (let attempt = 0; attempt < 2 && !ownerKnown; attempt++) {
      try {
        const response = await get(`/api/v1/profiles/${encodeURIComponent(handle)}`, { format: 'json', limit: 1 }, AbortSignal.any([signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]))
        if (response.status === 404) throw new HttpError(404, 'not_found')
        if (!response.ok) continue
        const body = await response.json() as { profile?: RawUser }
        if (body.profile?.protected) { announce(body.profile); throw new HttpError(403, 'private') }
        announce(body.profile)
      } catch (error) {
        if (error instanceof HttpError || signal.aborted) throw error
      }
    }
  })()

  const postsTask = (async () => {
    try { await readPosts() } finally { postsFinished = true; nudge() }
  })()
  async function readPosts() {
    // The import holds the connection open after the last post to send its summary line; at the cap there is nothing left to wait for.
    const cap = new AbortController()
    let lines = 0
    const response = await get(`/api/v1/profiles/${encodeURIComponent(handle)}/posts`, {
      format: 'ndjson',
      since: Math.floor(floor),
      max_posts: options.maxPosts,
      concurrency: options.concurrency,
      with_replies: 'true',
      with_reposts: 'true',
    }, AbortSignal.any([signal, cap.signal]))
    if (response.status === 404) throw new HttpError(404, 'not_found')
    if (response.status === 429) throw new HttpError(429, 'import allowance spent')
    if (!response.ok || !response.body) throw new HttpError(response.status, `import ${response.status}`)
    for await (const line of ndjson(response.body)) {
      const record = line as { post?: RawPost; error?: { detail?: string; status?: number }; meta?: unknown }
      if (record.error) throw new HttpError(record.error.status ?? 502, record.error.detail ?? 'import failed')
      const post = record.post
      if (!post) continue
      const last = ++lines >= options.maxPosts
      const at = post.created_timestamp ?? 0
      if (at && at < floor) { if (last) { cap.abort(); break } continue }
      mark('firstPost')
      if (!ownerKnown && !post.reposted_by && post.author?.screen_name?.toLowerCase() === handle.toLowerCase()) announce(post.author)
      posts += 1
      if (at && (postsOldest === null || at < postsOldest)) postsOldest = at
      if (post.id && (post.replies ?? 0) > 0 && !post.reposted_by && post.author?.screen_name?.toLowerCase() === handle.toLowerCase() && threadsQueued < options.threadBudget) {
        threadQueue.push(post.id)
        threadsQueued += 1
        nudge()
      }
      queue('posts', ownPostInteractions(post, handle, collector))
      if (last) { cap.abort(); break }
    }
    mark('postsDone')
  }

  const takeMentions = (list: RawPost[]) => {
    const found: Interaction[] = []
    for (const post of list) {
      const item = incomingInteraction(post, handle, collector)
      if (!item) continue
      mentions += 1
      if (item.at && (mentionsOldest === null || item.at < mentionsOldest)) mentionsOldest = item.at
      found.push(item)
    }
    if (found.length) mark('firstMention')
    queue('mentions', found)
  }

  interface Page { posts: RawPost[]; limit: number; cursor: string | null; accountLeft: number | null; degraded: boolean }
  const search = async (window: { since?: number; until?: number } = {}): Promise<Page> => {
    const response = await get('/api/v1/search', {
      q: `@${handle} -from:${handle}`,
      feed: 'latest',
      limit: 100,
      format: 'json',
      since: window.since === undefined ? undefined : Math.floor(window.since),
      until: window.until === undefined ? undefined : Math.ceil(window.until),
    })
    if (!response.ok) throw new HttpError(response.status, `search ${response.status}`)
    const body = await response.json() as { posts?: RawPost[]; limit?: number; nextCursor?: string | null }
    const rl = response.headers.get('ratelimit')
    return {
      posts: body.posts ?? [],
      limit: body.limit ?? 20,
      cursor: body.nextCursor ?? null,
      accountLeft: remaining(rl, 'account-key') ?? remaining(rl, 'account-ip'),
      degraded: response.headers.get('x-search-degraded') === 'true',
    }
  }

  let mentionsSource: 'search' | 'replies' | null = null
  const searchTask = (async (): Promise<boolean> => {
    let first: Page
    try {
      first = await search()
    } catch (error) {
      emit({ type: 'mentions-source', source: null, detail: (error as Error).message, t: t() })
      return false
    }
    if (first.degraded) return false
    mentionsSource = 'search'
    emit({ type: 'mentions-source', source: 'search', t: t() })
    takeMentions(first.posts)
    const stamps = first.posts.map((p) => p.created_timestamp ?? 0).filter(Boolean)
    if (first.posts.length < first.limit || !stamps.length) { mark('mentionsDone'); return true }
    // A full first page: carve the time before it into windows of the same span,
    // each expected to hold about one page, and read them all at once.
    const oldest = Math.min(...stamps)
    const span = Math.max(60, now - oldest)
    const allowance = first.accountLeft === null ? options.searchBudget : Math.max(0, first.accountLeft - 2)
    const count = Math.min(options.searchBudget - 1, allowance)
    const windows: { since: number; until: number }[] = []
    for (let i = 0; i < count; i++) {
      const until = oldest - i * span
      if (until <= floor) break
      windows.push({ since: Math.max(floor, until - span), until })
    }
    await Promise.all(windows.map(async (window) => {
      try { takeMentions((await search(window)).posts) } catch { /* one window failing leaves a gap, not an error */ }
    }))
    mark('mentionsDone')
    return true
  })()

  const readThreads = async (): Promise<number> => {
    let read = 0
    const worker = async () => {
      for (;;) {
        const id = threadQueue.shift()
        if (!id) {
          if (postsFinished) return
          await new Promise<void>((wake) => waiters.push(wake))
          continue
        }
        try {
          const response = await get('/api/v1/posts', { handle, id, format: 'json', replies: 'recent' }, AbortSignal.any([signal, AbortSignal.timeout(THREAD_TIMEOUT_MS)]))
          if (!response.ok) continue
          const body = await response.json() as { posts?: RawPost[] }
          read += 1
          takeMentions((body.posts ?? []).filter((p) => p.replying_to?.screen_name?.toLowerCase() === handle.toLowerCase()))
        } catch { /* a skipped thread only leaves its replies out */ }
      }
    }
    await Promise.all(Array.from({ length: THREAD_CONCURRENCY }, worker))
    return read
  }

  const mentionsTask = (async () => {
    if (await searchTask) return
    const read = await readThreads()
    mentionsSource = read > 0 ? 'replies' : null
    emit({ type: 'mentions-source', source: mentionsSource, t: t() })
    mark('mentionsDone')
  })()

  try {
    await Promise.all([profileTask, postsTask, mentionsTask])
    if (timer) clearTimeout(timer)
    flush()
    if (posts === 0) { emit({ type: 'error', code: 'empty', t: t() }); return }
    const oldest = postsOldest === null ? mentionsOldest : mentionsOldest === null ? postsOldest : Math.min(postsOldest, mentionsOldest)
    mark('done')
    emit({ type: 'done', posts, mentions, postsRead: posts + mentions, oldest, postsOldest, mentionsOldest, mentionsSource, timings, t: t() })
  } catch (error) {
    if (timer) clearTimeout(timer)
    if (options.signal.aborted) return
    inner.abort()
    const status = error instanceof HttpError ? error.status : 502
    const code = status === 404 ? 'not_found' : status === 403 ? 'private' : status === 429 ? 'rate_limited' : 'unavailable'
    emit({ type: 'error', code, detail: (error as Error).message, t: t() })
  }
}

/** Name and photo for people who only appeared as a handle; resolved all at once, streamed as each lands. */
export async function resolveProfiles(handles: string[], options: Pick<HarvestOptions, 'base' | 'key' | 'signal'>, emit: (person: Person) => void): Promise<{ resolved: number; slowestMs: number }> {
  const queue = [...new Set(handles)]
  let resolved = 0
  let slowestMs = 0
  const worker = async () => {
    for (let handle = queue.shift(); handle; handle = queue.shift()) {
      const started = performance.now()
      for (let attempt = 0; attempt < 2 && !options.signal.aborted; attempt++) {
        try {
          const url = new URL(`/api/v1/profiles/${encodeURIComponent(handle)}`, options.base)
          url.searchParams.set('format', 'json')
          url.searchParams.set('limit', '1')
          const response = await fetch(url, { headers: { Authorization: `Bearer ${options.key}` }, signal: AbortSignal.any([options.signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]) })
          if (response.status === 404) break
          if (!response.ok) continue
          const person = toPerson(((await response.json()) as { profile?: RawUser }).profile)
          if (person) { emit(person); resolved += 1 }
          break
        } catch {
          if (options.signal.aborted) return
        }
      }
      slowestMs = Math.max(slowestMs, performance.now() - started)
    }
  }
  await Promise.all(Array.from({ length: Math.min(25, queue.length) }, worker))
  return { resolved, slowestMs: Math.round(slowestMs) }
}
