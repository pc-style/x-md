import {
  WINDOW_DAYS,
  ingestIncoming,
  ingestOwn,
  mergePerson,
  normalizeAvatar,
  personFrom,
  rank,
  same,
  type Interaction,
  type Member,
  type Person,
  type Tweet,
} from './rank'

export class CircleError extends Error {
  constructor(readonly code: 'bad_handle' | 'not_found' | 'private' | 'empty' | 'no_one' | 'unavailable' | 'rate_limited' | 'missing_key' | 'aborted') {
    super(code)
    this.name = 'CircleError'
  }
}

export interface CircleSnapshot {
  partial: boolean
  owner: Person
  members: Member[]
  postsRead: number
  ownPosts: number
  mentions: number
  oldest: number | null
  mentionsRead: boolean
  createdAt: number
}

export interface CircleTiming {
  firstProgressMs: number | null
  firstCircleMs: number | null
  completeMs: number
  postsPerSec: number
}

export type CircleEvent =
  | { type: 'progress'; phase: 'posts' | 'people'; posts: number; mentions: number; elapsedMs: number }
  | ({ type: 'circle' } & CircleSnapshot)
  | { type: 'done'; timing: CircleTiming; snapshot: CircleSnapshot }
  | { type: 'error'; code: string }

export interface CollectOptions {
  signal?: AbortSignal
  onEvent: (event: CircleEvent) => void
  /** Bypass cached search and force a fresh timeline walk. */
  fresh?: boolean
  fetch?: typeof fetch
  now?: number
  portrait?: (handle: string, signal: AbortSignal) => Promise<Person | null>
}

const MENTION_SLICES = 4
const MENTION_PAGES = 2
const OWN_SLICES = 4
const OWN_PAGES = 3
const REPOST_SLICES = 2
const REPOST_PAGES = 2
/** Recent posts come from one bulk import. Search slices cover the rest of the window. */
const RECENT_IMPORT_DAYS = 7

function baseUrl(): string {
  return (process.env.X_MD_BASE ?? 'https://mdfromx.com').replace(/\/$/, '')
}

function authHeaders(): Headers {
  const key = process.env.X_MD_API_KEY
  if (!key) throw new CircleError('missing_key')
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${key}`)
  headers.set('Accept', 'application/json')
  return headers
}

async function problem(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { detail?: string; code?: string } | null
  const detail = `${body?.detail ?? ''} ${body?.code ?? ''}`
  if (response.status === 404 || body?.code === 'not_found') throw new CircleError(/protect|private/i.test(detail) ? 'private' : 'not_found')
  if (response.status === 429 || body?.code === 'rate_limited') throw new CircleError('rate_limited')
  throw new CircleError('unavailable')
}

async function defaultPortrait(handle: string, signal: AbortSignal): Promise<Person | null> {
  const timeout = AbortSignal.timeout(8000)
  const combined = AbortSignal.any([signal, timeout])
  try {
    const response = await fetch(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}`, {
      signal: combined,
      headers: { Accept: 'application/json', 'User-Agent': 'fast-x-circle' },
    })
    if (!response.ok) return null
    const body = await response.json() as { user?: { screen_name?: string; name?: string; avatar_url?: string } }
    return personFrom(body.user)
  } catch {
    return null
  }
}

function slices(nowMs: number, count: number): Array<{ since: Date; until: Date }> {
  const span = WINDOW_DAYS * 86400000
  const start = nowMs - span
  const step = span / count
  return Array.from({ length: count }, (_, index) => ({
    since: new Date(start + index * step),
    until: new Date(index === count - 1 ? nowMs : start + (index + 1) * step),
  }))
}

export async function collectCircle(handle: string, options: CollectOptions): Promise<void> {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new CircleError('bad_handle')
  const fetcher = options.fetch ?? fetch
  const signal = options.signal ?? AbortSignal.timeout(55000)
  const nowMs = options.now ?? Date.now()
  const nowSec = nowMs / 1000
  const cutoff = nowSec - WINDOW_DAYS * 86400
  const started = performance.now()
  const createdAt = nowMs
  const interactions: Interaction[] = []
  const seen = new Set<string>()
  const seenOwn = new Set<string>()
  const seenMentions = new Set<string>()
  let ownPosts = 0
  let mentions = 0
  let oldest: number | null = null
  let owner: Person | null = null
  let mentionOk = false
  let firstProgressMs: number | null = null
  let firstCircleMs: number | null = null
  const portraits = new Map<string, Person | null>()
  const portraitJobs = new Map<string, Promise<Person | null>>()

  const push = (interaction: Interaction) => {
    const key = `${interaction.tweetId}:${interaction.other.handle.toLowerCase()}:${interaction.kind}:${interaction.direction}`
    if (seen.has(key) || same(interaction.other.handle, handle)) return
    seen.add(key)
    interactions.push(interaction)
    if (interaction.at && (oldest == null || interaction.at < oldest)) oldest = interaction.at
  }

  const rememberOwner = (person: Person | null) => {
    owner = mergePerson(owner, person)
  }

  const loadPortrait = (name: string): Promise<Person | null> => {
    const key = name.toLowerCase()
    const existing = portraitJobs.get(key)
    if (existing) return existing
    const job = (options.portrait ?? defaultPortrait)(name, signal).then((person) => {
      portraits.set(key, person)
      return person
    }).catch(() => null)
    portraitJobs.set(key, job)
    return job
  }

  const applyPortraits = (members: Member[]): Member[] => members.map((member) => {
    const portrait = portraits.get(member.handle.toLowerCase())
    if (!portrait) return member
    const named = member.name.toLowerCase() === member.handle.toLowerCase() && portrait.name ? portrait.name : member.name
    return { ...member, name: named, avatar: member.avatar ?? normalizeAvatar(portrait.avatar) ?? portrait.avatar }
  })

  const snapshot = (partial: boolean, members: Member[]): CircleSnapshot => ({
    partial,
    owner: owner ?? { handle, name: handle, avatar: null },
    members,
    postsRead: ownPosts + mentions,
    ownPosts,
    mentions,
    oldest,
    mentionsRead: partial ? true : mentionOk,
    createdAt,
  })

  let closed = false
  let phase: 'posts' | 'people' = 'posts'
  let progressTimer: ReturnType<typeof setTimeout> | null = null
  let progressSent = false
  const sendProgress = () => {
    if (closed) return
    options.onEvent({ type: 'progress', phase, posts: ownPosts, mentions, elapsedMs: performance.now() - started })
  }
  const emitProgress = () => {
    if (!progressSent) {
      progressSent = true
      sendProgress()
      return
    }
    if (progressTimer) return
    progressTimer = setTimeout(() => {
      progressTimer = null
      sendProgress()
    }, 80)
  }

  let circleTimer: ReturnType<typeof setTimeout> | null = null
  const publish = (partial: boolean) => {
    if (closed) return
    const members = applyPortraits(rank(interactions, nowSec).slice(0, 50))
    for (const member of members) if (!member.avatar) void loadPortrait(member.handle)
    if (partial && members.length === 0) return
    if (firstCircleMs == null && members.length > 0) firstCircleMs = performance.now() - started
    options.onEvent({ type: 'circle', ...snapshot(partial, members) })
  }
  const scheduleCircle = () => {
    if (closed) return
    if (firstCircleMs == null) {
      publish(true)
      return
    }
    if (circleTimer) return
    circleTimer = setTimeout(() => {
      circleTimer = null
      publish(true)
    }, 180)
  }

  const noteProgress = () => {
    if (firstProgressMs == null && (ownPosts > 0 || mentions > 0)) firstProgressMs = performance.now() - started
    emitProgress()
    scheduleCircle()
  }

  const onOwn = (post: Tweet) => {
    if (post.id && seenOwn.has(post.id)) return
    if (post.id) seenOwn.add(post.id)
    const author = personFrom(post.author)
    if (author && same(author.handle, handle)) rememberOwner(author)
    const reposter = personFrom(post.reposted_by)
    if (reposter && same(reposter.handle, handle)) rememberOwner(reposter)
    if (!ingestOwn(post, handle, cutoff, push)) return
    ownPosts += 1
    noteProgress()
  }

  const onMention = (post: Tweet) => {
    if (!post.id || seenMentions.has(post.id)) return
    if (!ingestIncoming(post, handle, cutoff, push)) return
    seenMentions.add(post.id)
    mentions += 1
    noteProgress()
  }

  const readOwn = async (concurrency: number) => {
    const url = new URL(`${baseUrl()}/api/v1/profiles/${encodeURIComponent(handle)}/posts`)
    url.searchParams.set('since', new Date(nowMs - RECENT_IMPORT_DAYS * 86400000).toISOString())
    url.searchParams.set('max_posts', '400')
    url.searchParams.set('with_replies', 'true')
    url.searchParams.set('with_reposts', 'true')
    url.searchParams.set('concurrency', String(concurrency))
    url.searchParams.set('format', 'ndjson')
    if (options.fresh) url.searchParams.set('refresh', 'true')
    const response = await fetcher(url, { headers: authHeaders(), signal })
    if (!response.ok || !response.body) await problem(response)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const consume = (line: string) => {
      if (!line) return
      const message = JSON.parse(line) as { post?: Tweet; profile?: Tweet['author'] & { protected?: boolean }; error?: { code?: string; detail?: string } }
      if (message.error) {
        const detail = `${message.error.detail ?? ''} ${message.error.code ?? ''}`
        if (/protect|private/i.test(detail)) throw new CircleError('private')
        if (ownPosts === 0) throw new CircleError('unavailable')
        return
      }
      if (message.profile) {
        if (message.profile.protected) throw new CircleError('private')
        rememberOwner(personFrom(message.profile))
      }
      if (message.post) onOwn(message.post)
    }
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        consume(buffer.slice(0, newline).trim())
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
      }
    }
    consume(buffer.trim())
  }

  const searchQuery = async (query: string, ranges: Array<{ since: Date; until: Date }>, pages: number, onPost: (post: Tweet) => void): Promise<'ok' | 'limited' | 'fail'> => {
    let saw = false
    let limited = false
    const run = async (slice: { since: Date; until: Date }) => {
      let cursor: string | undefined
      for (let page = 0; page < pages; page += 1) {
        if (signal.aborted) throw new CircleError('aborted')
        const url = new URL(`${baseUrl()}/api/v1/search`)
        url.searchParams.set('q', query)
        url.searchParams.set('feed', 'latest')
        url.searchParams.set('limit', '100')
        url.searchParams.set('format', 'json')
        url.searchParams.set('full', 'true')
        url.searchParams.set('since', slice.since.toISOString())
        url.searchParams.set('until', slice.until.toISOString())
        if (options.fresh) url.searchParams.set('nocache', 'true')
        if (cursor) url.searchParams.set('cursor', cursor)
        const response = await fetcher(url, { headers: authHeaders(), signal })
        if (response.status === 429) {
          limited = true
          return
        }
        if (!response.ok) return
        const body = await response.json() as { posts?: Tweet[]; nextCursor?: string | null }
        saw = true
        for (const post of body.posts ?? []) onPost(post)
        if (!body.nextCursor) return
        cursor = body.nextCursor
      }
    }
    await Promise.all(ranges.map(async (slice) => {
      try {
        await run(slice)
      } catch (error) {
        if (error instanceof CircleError && error.code === 'aborted') throw error
      }
    }))
    if (saw) return 'ok'
    return limited ? 'limited' : 'fail'
  }

  const ownPost = (post: Tweet): boolean => {
    const author = post.author?.screen_name
    const repostedBy = post.reposted_by?.screen_name
    return (author != null && same(author, handle)) || (repostedBy != null && same(repostedBy, handle))
  }

  try {
    if (signal.aborted) throw new CircleError('aborted')
    const ownImport = readOwn(8).catch((error: unknown) => {
      if (error instanceof CircleError && (error.code === 'private' || error.code === 'not_found' || error.code === 'aborted')) throw error
    })
    const ownSearch = searchQuery(`from:${handle}`, slices(nowMs, OWN_SLICES), OWN_PAGES, (post) => {
      if (ownPost(post)) onOwn(post)
    })
    const reposts = searchQuery(`from:${handle} filter:nativeretweets`, slices(nowMs, REPOST_SLICES), REPOST_PAGES, (post) => {
      if (ownPost(post)) onOwn(post)
    })
    const incoming = searchQuery(`@${handle}`, slices(nowMs, MENTION_SLICES), MENTION_PAGES, onMention)
    const [, ownResult, repostResult, mentionResult] = await Promise.all([ownImport, ownSearch, reposts, incoming])
    if (mentionResult === 'ok' || mentionResult === 'limited') mentionOk = true
    const limited = ownResult === 'limited' || repostResult === 'limited' || mentionResult === 'limited'
    if (signal.aborted) throw new CircleError('aborted')
    if (ownPosts === 0) throw new CircleError(limited ? 'rate_limited' : 'empty')
    const ranked = rank(interactions, nowSec)
    if (ranked.length === 0) throw new CircleError('no_one')
    phase = 'people'
    sendProgress()
    await Promise.all(ranked.slice(0, 50).filter((member) => !member.avatar).map((member) => loadPortrait(member.handle)))
    closed = true
    if (circleTimer) clearTimeout(circleTimer)
    if (progressTimer) clearTimeout(progressTimer)
    const members = applyPortraits(ranked.slice(0, 50))
    const finalSnapshot = snapshot(false, members)
    if (firstCircleMs == null) firstCircleMs = performance.now() - started
    options.onEvent({ type: 'circle', ...finalSnapshot })
    const completeMs = performance.now() - started
    options.onEvent({
      type: 'done',
      timing: {
        firstProgressMs,
        firstCircleMs,
        completeMs,
        postsPerSec: finalSnapshot.postsRead / Math.max(completeMs / 1000, 0.001),
      },
      snapshot: finalSnapshot,
    })
  } catch (error) {
    if (error instanceof CircleError) throw error
    if (signal.aborted) throw new CircleError('aborted')
    throw new CircleError('unavailable')
  }
}
