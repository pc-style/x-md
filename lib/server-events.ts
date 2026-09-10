import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { waitUntil } from '@vercel/functions'
import { wantsJson } from './http.js'
import type { FxTweet, FxMediaItem } from './fxtwitter.js'

type Properties = Record<string, string | number | boolean | null>
type Provider = 'fxtwitter' | 'syndication' | 'contextdev' | 'firecrawl' | 'xsearch'
interface Context {
  route: string
  endpoint: string
  resultCount: number
  media?: Properties
  pending: Promise<void>[]
  failures: Map<Provider, string>
}
const context = new AsyncLocalStorage<Context>()

/** Same capture transport and production gate as request_completed. No caller data. */
export async function captureServerEvent(event: string, properties: Properties): Promise<void> {
  const token = process.env.POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST
  if (process.env.VERCEL_ENV !== 'production' || !token || !host?.startsWith('https://')) return
  try {
    const response = await fetch(`${host.replace(/\/$/, '')}/i/v0/e/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000),
      body: JSON.stringify({ api_key: token, event, uuid: randomUUID(), distinct_id: 'server', timestamp: new Date().toISOString(),
        properties: { ...properties, environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null } }),
    })
    if (!response.ok) console.warn('[analytics] PostHog rejected an event')
  } catch {
    console.warn('[analytics] PostHog event delivery failed')
  }
}

export type RequestErrorType = 'not_found' | 'rate_limited' | 'parse_error' | 'upstream_error' | 'validation_error'

const PROVIDER_CODE = /fxtwitter|syndication|firecrawl|contextdev|xsearch/

/** Coarse failure class from the catalog code first, the HTTP status second. */
export function errorTypeFor(code: string | undefined, status: number): RequestErrorType {
  if (code === 'rate_limited' || status === 429) return 'rate_limited'
  if (status === 404 || code === 'not_found' || code === 'route_not_found' || code === 'private_tweet') return 'not_found'
  if (code === 'invalid_body') return 'parse_error'
  if (status >= 500 || code === 'upstream_error' || code === 'search_unavailable' || code === 'all_providers_failed' || (code && PROVIDER_CODE.test(code))) return 'upstream_error'
  return 'validation_error'
}

const notedErrors = new WeakMap<object, RequestErrorType>()

/** Called by sendProblem so request_failed can classify by catalog code, not just status. */
export function noteRequestError(res: object, code: string | undefined, status: number): void {
  notedErrors.set(res, errorTypeFor(code, status))
}

export function notedErrorType(res: object, status: number): RequestErrorType {
  return notedErrors.get(res) ?? errorTypeFor(undefined, status)
}

function capture(event: string, properties: Properties, state = context.getStore()): void {
  if (!state) return
  state.pending.push(captureServerEvent(event, properties))
}

export function trackCache(hit: boolean): void {
  const state = context.getStore()
  if (!state) return
  capture(hit ? 'cache_hit' : 'cache_miss', {
    route: state.route, endpoint: state.endpoint, cache_key_type: state.route === 'convert' ? 'status' : state.route,
  })
}

export function trackRateLimit(limit_type: 'ip' | 'key' | 'global'): void {
  const state = context.getStore()
  if (state) capture('rate_limit_applied', { route: state.route, limit_type })
}

export function trackFallback(primary_provider: Provider, fallback_provider: Provider, reason: 'primary_timeout' | 'primary_error' | 'primary_empty' | 'primary_unavailable'): void {
  const state = context.getStore()
  if (state) {
    const failure = state.failures.get(primary_provider)
    const classified = reason === 'primary_error' && failure === 'timeout' ? 'primary_timeout' : reason === 'primary_error' && failure === 'empty_response' ? 'primary_empty' : reason
    capture('fallback_used', { route: state.route, primary_provider, fallback_provider, reason: classified })
  }
}

export function trackUpstream(provider: Provider, error_type: 'timeout' | 'http_error' | 'parse_failure' | 'empty_response' | 'network_error', upstream_status: number | null, started: number): void {
  const state = context.getStore()
  if (state) state.failures.set(provider, error_type)
  if (state) capture('upstream_error', { provider, route: state.route, error_type, upstream_status, duration_ms: Math.max(0, Math.round(performance.now() - started)) })
}

const responseReports = new WeakMap<Response, (kind: Parameters<typeof trackUpstream>[1]) => void>()

export function reportProviderResponse(response: Response, kind: Parameters<typeof trackUpstream>[1]): void {
  responseReports.get(response)?.(kind)
}

/** Tracks transport and JSON failures once per provider HTTP call, including swallowed failures. */
export async function providerFetch(provider: Provider, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const started = performance.now()
  let response: Response
  try {
    response = await fetch(input, init)
  } catch (error) {
    trackUpstream(provider, error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'timeout' : 'network_error', null, started)
    throw error
  }
  let reported = false
  const report = (kind: Parameters<typeof trackUpstream>[1]) => {
    if (!reported) trackUpstream(provider, kind, response.status, started)
    reported = true
  }
  responseReports.set(response, report)
  // A 404 is a missing resource, not a provider failure; callers that treat a
  // not-found as an outage (FxTwitter search) report it themselves.
  if (!response.ok && response.status !== 404) report('http_error')
  const json = response.json.bind(response)
  response.json = async () => {
    let data: unknown
    try { data = await json() } catch (error) { report('parse_failure'); throw error }
    if (data == null || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)) report('empty_response')
    else if (typeof data !== 'object') report('parse_failure')
    else if (typeof data === 'object') {
      const body = data as { success?: boolean; code?: number; message?: string; errors?: unknown[] }
      const notFound = body.code === 404 || body.message === 'NOT_FOUND' || body.message === 'PRIVATE_TWEET'
      if (!notFound && (body.success === false || (body.code ?? 0) >= 400 || body.errors?.length)) report('http_error')
    }
    return data
  }
  return response
}

/** Only count returned attachments; media.all duplicates the typed lists on some providers. */
export function trackResult(result: { posts?: FxTweet[]; users?: unknown[] }): void {
  const state = context.getStore()
  if (!state) return
  state.resultCount = result.posts?.length ?? result.users?.length ?? 0
  let images = 0
  let videos = 0
  let variantCount = 0
  let direct = false
  const visit = (post: FxTweet) => {
    const media = post.media
    const seen = new Set<string | FxMediaItem>()
    const add = (item: FxMediaItem, video: boolean) => {
      const key = item.url ?? item
      if (seen.has(key)) return
      seen.add(key)
      if (!video) { images++; return }
      videos++
      const urls = new Set([...(item.variants ?? []), ...(item.formats ?? [])].map(v => v.url).filter(Boolean))
      variantCount += urls.size
      direct ||= [item.url, ...urls].some(url => {
        try { const parsed = new URL(url ?? ''); return parsed.protocol === 'https:' && (parsed.hostname === 'video.twimg.com' || parsed.hostname.endsWith('.video.twimg.com')) } catch { return false }
      })
    }
    for (const item of media?.photos ?? []) add(item, false)
    for (const item of [...(media?.videos ?? []), ...(media?.animated ?? [])]) add(item, true)
    for (const item of media?.all ?? []) add(item, ['video', 'gif', 'animated_gif'].includes(item.type ?? ''))
    if (post.quote) visit(post.quote)
  }
  for (const post of result.posts ?? []) visit(post)
  if (images || videos) state.media = { media_type: images && videos ? 'mixed' : videos ? 'video' : 'image', variant_count: variantCount, has_direct_url: direct }
}

/** run(), rather than enterWith(), keeps concurrent requests and library calls isolated. */
export function withServerEvents(handlerKind: 'convert' | 'browse' | 'import' | 'oembed', handler: (req: VercelRequest, res: VercelResponse) => unknown) {
  return (req: VercelRequest, res: VercelResponse) => {
    const param = (name: string) => typeof req.query[name] === 'string' ? req.query[name] as string : ''
    const resource = ['profile', 'search', 'followers', 'following'].includes(param('resource')) ? param('resource') : ''
    const aggregate = handlerKind === 'browse' && (req.url ?? '').split('?')[0] === '/api/browse' && param('via') !== 'route'
    const endpoint = handlerKind === 'convert' ? (param('handle') && param('id') ? 'status_convert' : 'generic_convert')
      : handlerKind === 'oembed' ? 'oembed' : handlerKind === 'import' ? 'profile_import' : aggregate || !resource ? 'api_browse' : `${resource}_browse`
    const state: Context = { route: handlerKind === 'browse' && resource ? resource : handlerKind, endpoint, resultCount: 0, pending: [], failures: new Map() }
    // Imports have no Markdown representation: json unless ndjson was asked for.
    const format = handlerKind === 'import' ? (param('format') === 'ndjson' ? 'ndjson' : 'json') : handlerKind === 'oembed' || wantsJson(param('format'), String(req.headers.accept ?? '')) ? 'json' : param('format') === 'obsidian' && handlerKind === 'convert' ? 'obsidian' : 'markdown'
    return context.run(state, () => {
      capture('endpoint_called', { endpoint, format, full: param('full') === 'true',
        thread: /^(off|full|conversation|[0-9]{1,3})$/.test(param('thread')) ? param('thread') : 'full',
        replies: ['top', 'recent', 'off'].includes(param('replies')) ? param('replies') : 'top',
        nocache: ['true', '1', ...(handlerKind === 'convert' ? ['yes'] : [])].includes(param('nocache')) || ['1', 'true'].includes(process.env.CACHE_DISABLED ?? ''),
        has_handle: Boolean(param('handle')) })
      if (handlerKind === 'oembed') {
        const ua = String(req.headers['user-agent'] ?? '')
        const bot = ['Discordbot', 'Slackbot', 'TelegramBot'].find(name => ua.toLowerCase().includes(name.toLowerCase())) ?? null
        capture('oEmbed_requested', { requester_bot: bot, format: param('format') === 'xml' ? 'xml' : 'json' })
      }
      waitUntil(new Promise<void>(resolve => {
        const close = () => { res.off('finish', finish); void Promise.all(state.pending).then(() => resolve()) }
        const finish = () => {
          res.off('close', close)
          if (aggregate && resource) capture('batch_browse_called', { resource, format, result_count: state.resultCount, has_cursor: Boolean(param('cursor')) }, state)
          if (state.route === 'search') {
            const feed = param('feed').toLowerCase()
            capture('search_executed', { feed_type: feed === 'media' ? 'photos' : ['latest', 'top', 'photos', 'videos', 'users'].includes(feed) ? feed : 'latest', has_query: Boolean(param('q').trim()), result_count: state.resultCount }, state)
          }
          if (res.statusCode < 400 && req.method !== 'HEAD' && state.media) capture('media_resolved', { ...state.media, route: state.route }, state)
          void Promise.all(state.pending).then(() => resolve())
        }
        res.once('finish', finish)
        res.once('close', close)
      }))
      return handler(req, res)
    })
  }
}
