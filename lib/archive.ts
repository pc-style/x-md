import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'
import type { FxAuthor, FxTweet } from './fxtwitter.js'

export const ARCHIVE_EVENT = 'xmd_data_captured'
// UTF-8 bytes of the complete capture envelope, including token and properties.
export const MAX_ARCHIVE_EVENT_BYTES = 190_000
export interface ArchiveInput {
  resource: 'tweet' | 'profile' | 'search' | 'followers' | 'following'
  source: string
  cache?: string
  degraded?: boolean
  warnings?: string[]
  posts?: FxTweet[]
  users?: FxAuthor[]
  profile?: FxAuthor
}
export interface ArchivePayload { posts: FxTweet[]; users: FxAuthor[]; profile?: FxAuthor }
export interface ArchiveEvent {
  api_key: string
  event: typeof ARCHIVE_EVENT
  uuid: string
  distinct_id: string
  timestamp: string
  properties: {
    archive_schema_version: 1; request_id: string; captured_at: string
    resource: ArchiveInput['resource']; http_status: 200; source: string
    cache?: string; degraded: boolean; warnings?: string[]
    chunk_index: number; chunk_count: number; payload: ArchivePayload
    $process_person_profile: false; $geoip_disable: true; $ip: null
  }
}

type Rule = 'string' | 'number' | 'boolean' | 'url' | { [key: string]: Rule } | [Rule]
const fields = (names: string, rule: Rule): Record<string, Rule> => Object.fromEntries(names.split(' ').map(key => [key, rule]))
const authorRule: Rule = {
  ...fields('id name screen_name description location joined', 'string'),
  ...fields('url avatar_url banner_url', 'url'),
  ...fields('followers following likes media_count statuses', 'number'),
  protected: 'boolean', website: { url: 'url', display_url: 'string' },
  verification: { verified: 'boolean', type: 'string' },
}
const mediaItemRule: Rule = {
  ...fields('type format alt altText', 'string'), ...fields('url thumbnail_url', 'url'),
  ...fields('width height duration duration_ms bitrate', 'number'),
  variants: [{ url: 'url', content_type: 'string', bitrate: 'number' }],
  formats: [{ url: 'url', container: 'string', codec: 'string', bitrate: 'number' }],
}
const tweetRule: Rule = {
  ...fields('id text created_at lang source context', 'string'), url: 'url',
  ...fields('created_timestamp replies retweets reposts likes views bookmarks quotes', 'number'),
  possibly_sensitive: 'boolean',
  media: { photos: [mediaItemRule], videos: [mediaItemRule], animated: [mediaItemRule], all: [mediaItemRule],
    mosaic: { type: 'string', photos: [mediaItemRule], formats: { jpeg: 'url', webp: 'url' } } },
  poll: { choices: [{ label: 'string', count: 'number', percentage: 'number' }], total_votes: 'number', time_left_en: 'string', ends_at: 'string' },
  article: { title: 'string', preview_text: 'string', cover_media: { media_info: { original_img_url: 'url' } },
    content: { blocks: [{ type: 'string', text: 'string',
      inlineStyleRanges: [{ offset: 'number', length: 'number', style: 'string' }],
      data: { urls: [{ fromIndex: 'number', toIndex: 'number', text: 'string' }] } }] } },
  replying_to_status: ['string'],
}

// Never spread provider objects: they can contain private/personalized additions.
function select(value: unknown, rule: Rule): unknown {
  if (Array.isArray(rule)) return Array.isArray(value) ? value.map(item => select(item, rule[0])).filter(item => item !== undefined) : undefined
  if (typeof rule === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return Object.fromEntries(Object.entries(rule).flatMap(([key, child]) => {
      const selected = select((value as Record<string, unknown>)[key], child)
      return selected === undefined ? [] : [[key, selected]]
    }))
  }
  if (rule === 'url') {
    if (typeof value !== 'string') return undefined
    try {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password) return undefined
      url.search = ''; url.hash = ''
      return url.toString()
    } catch { return undefined }
  }
  return typeof value === rule && (rule !== 'number' || Number.isFinite(value)) ? value : undefined
}
function publicAuthor(value: FxAuthor | undefined): FxAuthor | undefined {
  if (!value || value.protected === true) return undefined
  const author = select(value, authorRule) as FxAuthor
  return author.id || author.screen_name ? author : undefined
}
function publicPost(value: FxTweet, depth = 0): FxTweet | undefined {
  if (!value || value.author?.protected === true) return undefined
  if (depth > 12) throw new Error('archive_record_depth')
  const post = select(value, tweetRule) as FxTweet
  if (!post.id || !(post.text?.trim() || post.article?.title || post.media && Object.keys(post.media).length)) return undefined
  post.author = publicAuthor(value.author)
  post.reposted_by = publicAuthor(value.reposted_by ?? undefined)
  if (value.quote) post.quote = publicPost(value.quote, depth + 1)
  post.replying_to = select(value.replying_to, Array.isArray(value.replying_to) ? ['string'] : {
    screen_name: 'string', status: 'string', url: 'url', profile_url: 'url',
  }) as FxTweet['replying_to']
  return post
}

/** Reject an oversized record atomically: never publish a silently truncated record. */
export function buildArchiveEvents(input: ArchiveInput, options: {
  token: string; distinctId: string; requestId?: string; capturedAt?: string; maxBytes?: number
}): ArchiveEvent[] {
  const requestId = options.requestId ?? randomUUID()
  const capturedAt = options.capturedAt ?? new Date().toISOString()
  const maxBytes = Math.min(options.maxBytes ?? MAX_ARCHIVE_EVENT_BYTES, MAX_ARCHIVE_EVENT_BYTES)
  if (!['tweet', 'profile', 'search', 'followers', 'following'].includes(input.resource)) return []
  // A protected profile must not leak its attached timeline either.
  if (input.profile?.protected === true) return []
  const posts = (input.posts ?? []).map(post => publicPost(post)).filter((post): post is FxTweet => !!post)
  const users = (input.users ?? []).map(publicAuthor).filter((user): user is FxAuthor => !!user)
  const profile = publicAuthor(input.profile)
  const records: Array<{ kind: 'posts' | 'users' | 'profile'; value: FxTweet | FxAuthor }> = [
    ...posts.map(value => ({ kind: 'posts' as const, value })),
    ...users.map(value => ({ kind: 'users' as const, value })),
    ...(profile ? [{ kind: 'profile' as const, value: profile }] : []),
  ]
  if (!records.length) return []
  const event = (payload: ArchivePayload, index: number, count: number): ArchiveEvent => ({
    api_key: options.token, event: ARCHIVE_EVENT, uuid: randomUUID(), distinct_id: options.distinctId, timestamp: capturedAt,
    properties: {
      archive_schema_version: 1, request_id: requestId, captured_at: capturedAt, resource: input.resource,
      http_status: 200, source: ['fxtwitter', 'syndication', 'contextdev', 'firecrawl', 'xsearch'].includes(input.source) ? input.source : 'unknown',
      ...(input.cache && ['hit', 'miss', 'bypass'].includes(input.cache) ? { cache: input.cache } : {}),
      degraded: input.degraded === true,
      // Warnings are codes, not arbitrary provider/request text.
      ...(input.warnings?.length ? { warnings: ['source_result_warning'] } : {}),
      chunk_index: index, chunk_count: count, payload,
      $process_person_profile: false, $geoip_disable: true, $ip: null,
    },
  })
  const chunks: ArchivePayload[] = []
  let current: ArchivePayload = { posts: [], users: [] }
  const append = (payload: ArchivePayload, record: typeof records[number]): ArchivePayload => record.kind === 'profile'
    ? { ...payload, profile: record.value as FxAuthor }
    : { ...payload, [record.kind]: [...payload[record.kind], record.value] }
  const fits = (payload: ArchivePayload) => Buffer.byteLength(JSON.stringify(event(payload, records.length, records.length)), 'utf8') < maxBytes
  for (const record of records) {
    const candidate = append(current, record)
    if (fits(candidate)) { current = candidate; continue }
    if (current.posts.length || current.users.length || current.profile) chunks.push(current)
    current = append({ posts: [], users: [] }, record)
    if (!fits(current)) throw new Error('archive_record_oversized')
  }
  chunks.push(current)
  return chunks.map((payload, index) => event(payload, index, chunks.length))
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  const match = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))
  try { return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined } catch { return undefined }
}
export function archiveOptedOut(req: IncomingMessage): boolean {
  return req.headers.dnt === '1' || req.headers['sec-gpc'] === '1' || req.headers['x-xmd-archive-opt-out'] === '1'
    || cookie(req, '__Host-xmd_archive_optout') === '1'
}
function actorId(req: IncomingMessage, res: ServerResponse, keyId: string | undefined, secret: string, requestId: string): string {
  if (res.getHeader('X-Api-Key-Status') === 'valid' && keyId) return `key:${createHmac('sha256', secret).update(`key:${keyId}`).digest('hex')}`
  const actor = cookie(req, '__Host-xmd_actor')
  if (actor && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(actor)) {
    return `browser:${createHmac('sha256', secret).update(`browser:${actor}`).digest('hex')}`
  }
  return `anonymous:${requestId}`
}

/** Best-effort delivery after a completed 200 response; not a durable queue. */
export function captureArchive(req: IncomingMessage, res: ServerResponse, input: ArchiveInput, identity: { keyId?: string } = {}): void {
  const token = process.env.POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST
  const secret = process.env.XMD_ARCHIVE_ACTOR_SECRET
  if (process.env.XMD_ARCHIVE_ENABLED !== 'true' || process.env.VERCEL_ENV !== 'production'
    || !token || !host?.startsWith('https://') || !secret || secret.length < 32
    || req.method !== 'GET' || archiveOptedOut(req)) return
  async function send() {
    if (res.statusCode !== 200) return
    try {
      const requestId = randomUUID()
      const events = buildArchiveEvents(input, { token: token!, requestId,
        distinctId: actorId(req, res, identity.keyId, secret!, requestId) })
      // Sequential requests keep pressure bounded; a failed chunk stops the batch.
      for (const event of events) {
        const response = await fetch(`${host!.replace(/\/$/, '')}/i/v0/e/`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // Never replay content or the project token to a redirect target.
          redirect: 'error',
          signal: AbortSignal.timeout(3000), body: JSON.stringify(event),
        })
        if (!response.ok) { console.warn('[archive] PostHog rejected a chunk; archive may be incomplete'); return }
      }
    } catch (error) {
      const reason = error instanceof Error && ['archive_record_oversized', 'archive_record_depth'].includes(error.message)
        ? error.message : 'delivery_or_serialization_failed'
      // Only fixed reason codes; no records, IDs, headers or error details.
      console.warn(`[archive] ${reason}; archive not guaranteed`)
    }
  }
  waitUntil(new Promise<void>(resolve => {
    const onClose = () => { res.off('finish', onFinish); resolve() }
    const onFinish = () => { res.off('close', onClose); void send().finally(resolve) }
    res.once('finish', onFinish)
    res.once('close', onClose)
  }))
}
