import { AsyncLocalStorage } from 'node:async_hooks'
import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'

type Endpoint = 'convert' | 'browse' | 'oembed' | 'mcp' | 'index' | 'notfound'

export type AnalyticsEndpoint =
  | 'status_convert'
  | 'generic_convert'
  | 'profile_browse'
  | 'search_browse'
  | 'followers_browse'
  | 'following_browse'
  | 'oembed'
  | 'api_browse'

export type CacheKeyType = 'status' | 'profile' | 'search' | 'followers' | 'following'
export type RateLimitType = 'ip' | 'key' | 'global'
export type UpstreamErrorType = 'timeout' | 'http_error' | 'parse_failure' | 'empty_response'
export type FallbackReason = 'primary_timeout' | 'primary_error' | 'primary_empty'

/** Only a verified, internal key ID may be assigned here. Never a bearer token. */
interface RequestIdentity {
  keyId?: string
}

interface RequestErrorNote {
  type: string
  message?: string
}

interface AnalyticsContext {
  identity: RequestIdentity
  route: string
  endpoint?: AnalyticsEndpoint
  requestId: string
  started: number
  req: IncomingMessage
  error?: RequestErrorNote
}

const EVENTS = new Set([
  'request_completed',
  'endpoint_called',
  'request_failed',
  'upstream_error',
  'cache_hit',
  'cache_miss',
  'media_resolved',
  'fallback_used',
  'rate_limit_applied',
  'batch_browse_called',
  'search_executed',
  'oEmbed_requested',
])

const CACHE_KEY_TYPES = new Set<string>(['status', 'profile', 'search', 'followers', 'following'])
const FORMATS = new Set(['markdown', 'obsidian', 'json'])
const REPLIES = new Set(['top', 'recent', 'off'])
const FEEDS = new Set(['latest', 'top', 'photos', 'videos', 'users'])
const BROWSE_RESOURCES = new Set(['profile', 'search', 'followers', 'following'])
const OEMBED_FORMATS = new Set(['json', 'xml'])
const ERROR_TYPES = new Set(['not_found', 'upstream_error', 'parse_error', 'rate_limited', 'validation_error'])
const UPSTREAM_ERROR_TYPES = new Set<string>(['timeout', 'http_error', 'parse_failure', 'empty_response'])
const FALLBACK_REASONS = new Set<string>(['primary_timeout', 'primary_error', 'primary_empty'])
const RATE_LIMIT_TYPES = new Set<string>(['ip', 'key', 'global'])
const MEDIA_TYPES = new Set(['video', 'image', 'mixed'])

const context = new AsyncLocalStorage<AnalyticsContext>()
const byResponse = new WeakMap<object, AnalyticsContext>()

function config(): { token: string; host: string } | undefined {
  const token = process.env.POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST
  if (process.env.VERCEL_ENV !== 'production' || !token || !host?.startsWith('https://')) return undefined
  return { token, host: host.replace(/\/$/, '') }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'https://x.pcstyle.dev').searchParams
  } catch {
    return new URLSearchParams()
  }
}

function queryParam(req: IncomingMessage, key: string): string | undefined {
  const fromUrl = queryOf(req).get(key)
  if (fromUrl != null && fromUrl !== '') return fromUrl
  const query = (req as IncomingMessage & { query?: Record<string, unknown> }).query
  const value = query?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'https://x.pcstyle.dev').pathname
  } catch {
    return ''
  }
}

function truthy(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'yes'
}

function threadValue(raw: string | undefined): string {
  if (!raw) return 'full'
  if (raw === 'off' || raw === 'full' || raw === 'conversation') return raw
  if (/^\d+$/.test(raw)) return raw
  return 'full'
}

function classifyEndpoint(endpoint: Endpoint, resource: unknown, req: IncomingMessage): AnalyticsEndpoint | undefined {
  if (endpoint === 'oembed') return 'oembed'
  if (endpoint === 'convert') {
    return queryParam(req, 'handle') && queryParam(req, 'id') ? 'status_convert' : 'generic_convert'
  }
  if (endpoint !== 'browse') return undefined
  const via = queryParam(req, 'via')
  if (requestPath(req) === '/api/browse' && via !== 'route') return 'api_browse'
  const named = String(resource ?? queryParam(req, 'resource') ?? '')
  if (named === 'profile') return 'profile_browse'
  if (named === 'search') return 'search_browse'
  if (named === 'followers') return 'followers_browse'
  if (named === 'following') return 'following_browse'
  return 'api_browse'
}

function trafficType(req: IncomingMessage | undefined): 'AI Agent' | 'Bot' | undefined {
  const ua = String(req?.headers['user-agent'] ?? '')
  if (!ua) return undefined
  if (/gptbot|claudebot|chatgpt|anthropic|perplexity|google-extended|cohere-ai|amazonbot|bytespider|meta-externalagent|ccbot|ai2bot/i.test(ua)) {
    return 'AI Agent'
  }
  if (/bot|crawler|spider|slackbot|slack-img|discordbot|telegrambot|facebookexternalhit|linkedinbot|whatsapp/i.test(ua)) {
    return 'Bot'
  }
  return undefined
}

function requesterBot(ua: string): string | null {
  if (/discordbot/i.test(ua)) return 'Discordbot'
  if (/slackbot|slack-img/i.test(ua)) return 'Slackbot'
  if (/telegrambot/i.test(ua)) return 'TelegramBot'
  return null
}

export function errorTypeFor(code: string | undefined, status: number): string {
  if (code === 'rate_limited' || status === 429) return 'rate_limited'
  if (code === 'not_found' || code === 'route_not_found' || code === 'private_tweet' || status === 404) return 'not_found'
  if (code === 'invalid_body' || code?.endsWith('_invalid')) return 'parse_error'
  if (
    code === 'upstream_error'
    || code === 'search_unavailable'
    || code === 'all_providers_failed'
    || code?.includes('fxtwitter')
    || code?.includes('syndication')
    || code?.includes('firecrawl')
    || code?.includes('contextdev')
    || status >= 500
  ) return 'upstream_error'
  return 'validation_error'
}

function safeMessage(value: string | undefined): string | undefined {
  if (!value) return undefined
  const cleaned = value
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/@\w+/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > 200 ? `${cleaned.slice(0, 199)}…` : cleaned
}

function distinctId(token: string, ctx: AnalyticsContext | undefined, keyStatus?: unknown): string {
  if (keyStatus === 'valid' && ctx?.identity.keyId) {
    return `key:${createHmac('sha256', token).update(ctx.identity.keyId).digest('hex')}`
  }
  return `anonymous:${ctx?.requestId ?? randomUUID()}`
}

function baseProperties(ctx: AnalyticsContext | undefined): Record<string, unknown> {
  const traffic = trafficType(ctx?.req)
  return {
    environment: 'production',
    $process_person_profile: false,
    $geoip_disable: true,
    $ip: null,
    ...(traffic ? { $virt_traffic_type: traffic } : {}),
  }
}

async function deliver(event: string, properties: Record<string, unknown>, id: string, token: string, host: string): Promise<void> {
  try {
    const uuid = randomUUID()
    const response = await fetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        api_key: token,
        event,
        uuid,
        distinct_id: id,
        timestamp: new Date().toISOString(),
        properties,
      }),
    })
    if (!response.ok) console.warn('[analytics] PostHog rejected an event')
  } catch {
    // Analytics must never change an API response or log request details.
    console.warn('[analytics] PostHog event delivery failed')
  }
}

function emit(
  event: string,
  properties: Record<string, unknown>,
  ctx?: AnalyticsContext,
  keyStatus?: unknown,
): Promise<void> {
  const cfg = config()
  if (!cfg || !EVENTS.has(event)) return Promise.resolve()
  const store = ctx ?? context.getStore()
  return deliver(event, { ...baseProperties(store), ...properties }, distinctId(cfg.token, store, keyStatus), cfg.token, cfg.host)
}

function enqueue(event: string, properties: Record<string, unknown>, ctx?: AnalyticsContext, keyStatus?: unknown): void {
  waitUntil(emit(event, properties, ctx, keyStatus))
}

/** Personless production capture. Explicit fields only; never serialize the request. */
export function capture(event: string, properties: Record<string, unknown>): void {
  enqueue(event, properties, context.getStore())
}

export function currentRoute(): string {
  return context.getStore()?.route ?? 'unknown'
}

export function currentEndpoint(): AnalyticsEndpoint | 'unknown' {
  return context.getStore()?.endpoint ?? 'unknown'
}

export function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

export function fallbackReasonFor(error: unknown): FallbackReason {
  if (isTimeoutError(error)) return 'primary_timeout'
  if (error instanceof Error && /empty/i.test(error.message)) return 'primary_empty'
  return 'primary_error'
}

export function noteRequestError(res: object, code: string, message?: string): void {
  const ctx = byResponse.get(res) ?? context.getStore()
  if (!ctx) return
  ctx.error = { type: errorTypeFor(code, 0), message: safeMessage(message) }
}

export function captureCacheLookup(status: 'hit' | 'miss' | 'bypass', cacheKeyType: string): void {
  if (status !== 'hit' && status !== 'miss') return
  const type = CACHE_KEY_TYPES.has(cacheKeyType) ? cacheKeyType : 'unknown'
  capture(status === 'hit' ? 'cache_hit' : 'cache_miss', {
    route: currentRoute(),
    endpoint: currentEndpoint(),
    cache_key_type: type,
  })
}

export function captureUpstreamError(input: {
  provider: string
  errorType: UpstreamErrorType
  upstreamStatus?: number | null
  durationMs: number
  route?: string
}): void {
  const errorType = UPSTREAM_ERROR_TYPES.has(input.errorType) ? input.errorType : 'http_error'
  capture('upstream_error', {
    provider: input.provider,
    route: input.route ?? currentRoute(),
    error_type: errorType,
    upstream_status: typeof input.upstreamStatus === 'number' ? input.upstreamStatus : null,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
  })
}

export function captureFallback(input: {
  primaryProvider: string
  fallbackProvider: string
  reason: FallbackReason
  route?: string
}): void {
  capture('fallback_used', {
    primary_provider: input.primaryProvider,
    fallback_provider: input.fallbackProvider,
    reason: FALLBACK_REASONS.has(input.reason) ? input.reason : 'primary_error',
    route: input.route ?? currentRoute(),
  })
}

export function captureRateLimit(limitType: RateLimitType, route?: string): void {
  capture('rate_limit_applied', {
    limit_type: RATE_LIMIT_TYPES.has(limitType) ? limitType : 'ip',
    route: route ?? currentRoute(),
  })
}

export function captureSearchExecuted(input: {
  feedType: string
  hasQuery: boolean
  resultCount: number
}): void {
  const feed = FEEDS.has(input.feedType) ? input.feedType : 'latest'
  capture('search_executed', {
    feed_type: feed,
    has_query: input.hasQuery,
    result_count: Math.max(0, Math.round(input.resultCount)),
  })
}

export function captureBatchBrowse(input: {
  resource: string
  format: string
  resultCount: number
  hasCursor: boolean
}): void {
  if (!BROWSE_RESOURCES.has(input.resource)) return
  capture('batch_browse_called', {
    resource: input.resource,
    format: input.format === 'json' ? 'json' : 'markdown',
    result_count: Math.max(0, Math.round(input.resultCount)),
    has_cursor: input.hasCursor,
  })
}

export function captureOEmbedRequested(userAgent: string, format?: string | null): void {
  capture('oEmbed_requested', {
    requester_bot: requesterBot(userAgent),
    format: format && OEMBED_FORMATS.has(format) ? format : 'json',
  })
}

interface MediaLike {
  photos?: unknown[]
  videos?: Array<{ url?: string; variants?: unknown[] }>
  animated?: Array<{ url?: string; variants?: unknown[] }>
  all?: Array<{ type?: string; url?: string; variants?: unknown[] }>
}

function mediaItems(media: MediaLike | undefined): Array<{ type?: string; url?: string; variants?: unknown[] }> {
  if (!media) return []
  if (media.all?.length) return media.all
  return [
    ...(media.photos ?? []).map(() => ({ type: 'photo' })),
    ...(media.videos ?? []).map((item) => ({ type: 'video', ...item })),
    ...(media.animated ?? []).map((item) => ({ type: 'animated_gif', ...item })),
  ]
}

export function captureMediaResolved(posts: ReadonlyArray<{ media?: MediaLike; quote?: { media?: MediaLike } }>): void {
  const items = posts.flatMap((post) => [...mediaItems(post.media), ...mediaItems(post.quote?.media)])
  if (!items.length) return
  const videos = items.filter((item) => item.type === 'video' || item.type === 'animated_gif' || item.type === 'animated')
  const images = items.filter((item) => item.type === 'photo' || item.type === 'image')
  const mediaType = videos.length && images.length ? 'mixed' : videos.length ? 'video' : 'image'
  if (!MEDIA_TYPES.has(mediaType)) return
  capture('media_resolved', {
    media_type: mediaType,
    variant_count: videos.reduce((sum, item) => sum + (item.variants?.length ?? 0), 0),
    has_direct_url: videos.some((item) => Boolean(item.url) || Boolean(item.variants?.length)),
    route: currentRoute(),
  })
}

function endpointProperties(req: IncomingMessage, endpoint: AnalyticsEndpoint): Record<string, unknown> {
  const format = queryParam(req, 'format')
  const replies = queryParam(req, 'replies')
  return {
    endpoint,
    format: format && FORMATS.has(format) ? format : 'markdown',
    full: truthy(queryParam(req, 'full')),
    thread: threadValue(queryParam(req, 'thread')),
    replies: replies && REPLIES.has(replies) ? replies : 'top',
    nocache: truthy(queryParam(req, 'nocache')),
    has_handle: Boolean(queryParam(req, 'handle')),
  }
}

/**
 * One personless event per completed production function response. Explicit
 * fields only: never serialize the request, URL, headers, body, or errors.
 * CDN hits don't invoke the function and are intentionally not counted.
 */
export function trackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: Endpoint,
  resource?: unknown,
): RequestIdentity {
  const identity: RequestIdentity = {}
  const cfg = config()
  if (!cfg || req.method === 'OPTIONS') return identity

  const started = performance.now()
  const route = endpoint === 'browse' && ['profile', 'search', 'followers', 'following'].includes(String(resource))
    ? String(resource) : endpoint
  const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? req.method : 'OTHER'
  const named = classifyEndpoint(endpoint, resource, req)
  const ctx: AnalyticsContext = {
    identity,
    route,
    endpoint: named,
    requestId: randomUUID(),
    started,
    req,
  }
  byResponse.set(res, ctx)
  context.enterWith(ctx)

  if (named) enqueue('endpoint_called', endpointProperties(req, named), ctx)

  async function send() {
    const cacheHeader = res.getHeader('X-Cache')
    const cache = cacheHeader === 'HIT' ? 'hit' : cacheHeader === 'MISS' ? 'miss' : cacheHeader === 'BYPASS' ? 'bypass' : 'unknown'
    const keyStatus = res.getHeader('X-Api-Key-Status')
    const auth = keyStatus === 'valid' || keyStatus === 'invalid' || keyStatus === 'unverified' ? keyStatus : 'anonymous'
    const status = res.statusCode
    const duration = Math.max(0, Math.round(performance.now() - started))
    await emit('request_completed', {
      route,
      method,
      status,
      duration_ms: duration,
      cache,
      access: auth === 'valid' ? 'key' : 'public',
      key_status: auth,
      degraded: res.getHeader('X-Search-Degraded') === 'true',
    }, ctx, auth)
    if (status >= 400) {
      const noted = ctx.error
      const errorType = noted?.type && ERROR_TYPES.has(noted.type) ? noted.type : errorTypeFor(undefined, status)
      await emit('request_failed', {
        route,
        status,
        error_type: errorType,
        ...(noted?.message ? { error_message: noted.message } : {}),
        duration_ms: duration,
      }, ctx, auth)
    }
  }

  // Register before returning the response so Vercel keeps the send alive.
  // A disconnected request without a completed response isn't counted.
  waitUntil(new Promise<void>((resolve) => {
    const onClose = () => { res.off('finish', onFinish); resolve() }
    const onFinish = () => { res.off('close', onClose); void send().finally(resolve) }
    res.once('finish', onFinish)
    res.once('close', onClose)
  }))
  return identity
}
