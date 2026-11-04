import { upstreamHealth } from '../lib/upstream-health.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defaultAllowedOrigins, type Plugin } from 'vite'
import { browse, browseResponse, type BrowseResource } from '../lib/browse'
import { adminAuthorized, adminConfigured } from '../lib/admin'
import { handleKeysApi, handlePoolApi } from '../lib/adminApi'
import { callerHeaders, keyRequirementFailure, resolveCaller } from '../lib/apiauth'
import { ConvertError as BrowseError } from '../lib/errors'
import { acceptedRepresentation, parseJsonBody, requestOrigin, setCorsHeaders, wantsJson, wantsMarkdown } from '../lib/http'
import {
  applyExhaustedQuota,
  applyQuotaPolicyOnly,
  applyRequestQuota,
  chargeRequestQuota,
  settleRequestQuota,
  type QuotaCaller,
  type QuotaScope,
  type RequestQuota,
} from '../lib/ratelimit-headers'
import { clientIp } from '../lib/ratelimit'
import {
  acceptPrefersHtml,
  ConvertError,
  convertTweet,
  markdownResponse,
  POST_REPRESENTATIONS,
  STATUS_PATH,
} from '../lib/converter'
import { embedResponse, isEmbedUserAgent, oembedResponse } from '../lib/embed'
import {
  appendLink,
  problemDetails,
  problemFrom,
  problemResponse,
  requestInstance,
  setDeprecationHeaders,
  type ProblemDetails,
} from '../lib/apierror'
import { browseNotFoundDetail, notFoundResponse, safePath } from '../lib/notfound'
import { browseSuccessor } from '../api/browse'
import { apiIndexDocument, apiIndexMarkdown } from '../api/index'
import { CONTENT_TYPE, selectRepresentation } from '../lib/negotiate'
import mcpHandler from '../api/mcp'
import importHandler from '../api/import'

const HANDLE = '[A-Za-z0-9_]{1,15}'
/** First path segments that are site routes, never handles. */
const RESERVED = ['api', 'docs', 'search', 'oembed']

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

/** The production problem+json writer, so dev and deployed errors agree byte for byte. */
function respondProblem(req: IncomingMessage, res: ServerResponse, problem: ProblemDetails): void {
  const { status, headers, body } = problemResponse(problem, String(req.headers.accept ?? ''))
  res.statusCode = status
  for (const [key, value] of Object.entries(headers)) {
    if (key === 'Link') appendLink(res, value)
    else res.setHeader(key, value)
  }
  res.end(req.method === 'HEAD' ? undefined : body)
}

function problemInstance(req: IncomingMessage): string {
  return requestInstance(req, requestOrigin(req))
}

function fail(req: IncomingMessage, res: ServerResponse, code: string, detail?: string): void {
  respondProblem(req, res, problemDetails(code, { instance: problemInstance(req), detail }))
}

/**
 * Advertises the route's policies, which is all an uncharged response — a
 * preflight or a 405 — can claim, then answers OPTIONS. A charged request
 * overwrites the header with its own state, as the deployed handlers do.
 */
function preflight(req: IncomingMessage, res: ServerResponse, scope: QuotaScope, caller: QuotaCaller): boolean {
  applyQuotaPolicyOnly(res, scope, caller)
  if (req.method !== 'OPTIONS') return false
  res.statusCode = 204
  res.end()
  return true
}

/** Rejects non-GET/HEAD methods. Returns true if the request was answered. Call after `preflight`. */
function rejectMethod(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false
  res.setHeader('Allow', 'GET, HEAD, OPTIONS')
  fail(req, res, 'method_not_allowed', `${req.method} is not supported on this route. x.md only reads public X content.`)
  return true
}

/** Charges the request against its quota and answers 429 once the front door is spent. */
async function enforceQuota(
  req: IncomingMessage,
  res: ServerResponse,
  scope: QuotaScope,
  caller: QuotaCaller,
): Promise<boolean> {
  return answerQuota(req, res, await chargeRequestQuota(scope, caller))
}

/** Advertises a charged request's quota and answers 429 when the front door rejected it. */
function answerQuota(req: IncomingMessage, res: ServerResponse, quota: RequestQuota): boolean {
  applyRequestQuota(res, quota)
  if (quota.allowed) return false
  applyExhaustedQuota(res, quota, 'api-ip', quota.retryAfter)
  respondProblem(
    req,
    res,
    problemDetails('rate_limited', {
      instance: problemInstance(req),
      detail: 'Too many requests from this address. Cached responses do not count against the allowance.',
      retryAfter: quota.retryAfter,
    }),
  )
  return true
}

async function handleConvert(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = url.pathname

  const statusMatch = pathname.match(STATUS_PATH)
  const isApi = pathname === '/api/convert'

  if (!isApi && !statusMatch) return false

  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  // Mirrors production: the unversioned alias is deprecated, the permalink and
  // versioned routes (which carry via=route) are not. Set before anything can
  // answer, so a preflight, a 429 and a 405 carry the signal too.
  if (isApi && url.searchParams.get('via') !== 'route') setDeprecationHeaders(res, '/api/v1/posts')
  if (preflight(req, res, 'read', caller)) return true
  // Charged ahead of the method guard, as api/convert.ts does, so a 405 reports
  // the remaining allowance too.
  if (await enforceQuota(req, res, 'read', caller)) return true
  if (rejectMethod(req, res)) return true

  const accept = String(req.headers.accept ?? '')
  const userAgent = String(req.headers['user-agent'] ?? '')
  const requestedFormat = url.searchParams.get('format')
  const asJson = wantsJson(requestedFormat, accept, POST_REPRESENTATIONS)
  const asMarkdown = wantsMarkdown(requestedFormat, accept, POST_REPRESENTATIONS)
  const asEmbed = !requestedFormat && !asJson && !asMarkdown && isEmbedUserAgent(userAgent)
  const asHtml = !requestedFormat && !asJson && !asMarkdown && !asEmbed && acceptPrefersHtml(accept)

  // As api/convert.ts: a key that does not verify is refused, private mode
  // gates everything but a keyless Open Graph card, and a keyed response stays
  // out of shared caches whatever the renderer chose.
  const resolved = await resolveCaller(req.headers)
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  if (resolved.status === 'invalid') {
    fail(req, res, 'invalid_key', 'Invalid or disabled API key.')
    return true
  }
  const keyFailure = keyRequirementFailure(resolved)
  if (keyFailure && !(asEmbed && !req.headers.authorization)) {
    fail(req, res, 'unauthorized', keyFailure)
    return true
  }
  if (!requestedFormat && !asEmbed && acceptedRepresentation(accept, POST_REPRESENTATIONS) === null) {
    fail(req, res, 'not_acceptable', 'Accept refuses text/markdown, application/json and text/html, the only representations of a post.')
    return true
  }

  try {
    const result = await convertTweet({
      origin: requestOrigin(req),
      url: url.searchParams.get('url'),
      handle: statusMatch?.[1] ?? url.searchParams.get('handle'),
      id: statusMatch?.[2] ?? url.searchParams.get('id'),
      format: url.searchParams.get('format'),
      thread: url.searchParams.get('thread'),
      userinfo: url.searchParams.get('userinfo'),
      nocache: url.searchParams.get('nocache'),
      full: url.searchParams.get('full'),
      context: url.searchParams.get('context'),
      replies: url.searchParams.get('replies'),
    })

    const { status, headers, body } = asEmbed
      ? embedResponse(result, { origin: requestOrigin(req), userAgent })
      : markdownResponse(result, asJson, asHtml)
    res.statusCode = status
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }
    for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(body)
    }
  } catch (error) {
    if (!(error instanceof ConvertError)) console.error(error)
    respondProblem(req, res, problemFrom(error, problemInstance(req)))
  }

  return true
}

async function handleOembed(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, '')
  if (path !== '/oembed' && path !== '/api/oembed') return false
  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  if (preflight(req, res, 'read', caller)) return true
  if (rejectMethod(req, res)) return true
  if (await enforceQuota(req, res, 'read', caller)) return true
  const { status, headers, body } = oembedResponse(
    {
      url: url.searchParams.get('url'),
      text: url.searchParams.get('text'),
      author: url.searchParams.get('author'),
      status: url.searchParams.get('status'),
      provider: url.searchParams.get('provider'),
    },
    requestOrigin(req),
  )
  res.statusCode = status
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value)
  }
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

async function handleBrowse(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, '') || '/'
  let resource: BrowseResource | undefined
  let handle: string | undefined
  // /api/browse is claimed even without a resource, so a missing one is the
  // handler's own 400 here as it is in production, not an unrouted path.
  const isBrowseApi = path === '/api/browse'
  if (isBrowseApi) resource = (url.searchParams.get('resource') ?? undefined) as BrowseResource | undefined
  else if (path === '/search') resource = 'search'
  else {
    const match = path.match(new RegExp(`^\/(${HANDLE})(?:\/(followers|following))?$`))
    if (!match || RESERVED.includes(match[1] ?? '')) return false
    handle = match[1]
    resource = (match[2] as BrowseResource | undefined) ?? 'profile'
  }
  if (!resource && !isBrowseApi) return false
  setCorsHeaders(res)
  const scope: QuotaScope = resource === 'search' ? 'search' : 'read'
  // Mirrors production: only a direct /api/browse call is the deprecated alias.
  if (isBrowseApi && url.searchParams.get('via') !== 'route') {
    setDeprecationHeaders(res, browseSuccessor(resource, url.searchParams.get('handle') ?? undefined))
  }
  if (preflight(req, res, scope, { ip: clientIp(req.headers) })) return true
  if (rejectMethod(req, res)) return true
  const resolved = await resolveCaller(req.headers)
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  if (resolved.status === 'invalid') {
    fail(req, res, 'invalid_key', 'Invalid or disabled API key.')
    return true
  }
  const keyFailure = keyRequirementFailure(resolved)
  if (keyFailure) {
    fail(req, res, 'unauthorized', keyFailure)
    return true
  }
  // Charged after the caller is known, so a verified key's own policy is part of
  // the quota it is measured against.
  const quotaCaller: QuotaCaller =
    resolved.caller.kind === 'key'
      ? { ip: resolved.ip, key: { id: resolved.caller.id, limit: resolved.caller.limit } }
      : { ip: resolved.ip }
  // As in api/browse.ts: the cache lookup overlaps the front-door charge, and
  // browse waits for the verdict before spending anything deeper.
  const charged = chargeRequestQuota(scope, quotaCaller)
  // `browse` rejects invalid input before it awaits this verdict, so a charge
  // that fails in that window needs an observer of its own; the handler's
  // own `await charged` below still surfaces the failure.
  const admission = charged.then((quota) => quota.allowed)
  admission.catch(() => undefined)
  const pending = browse({ id: url.searchParams.get('id'), require_live: url.searchParams.get('require_live'), include_posts: url.searchParams.get('include_posts'), with_replies: url.searchParams.get('with_replies'), with_reposts: url.searchParams.get('with_reposts'), since: url.searchParams.get('since'), until: url.searchParams.get('until'), resource, handle: handle ?? url.searchParams.get('handle'), q: url.searchParams.get('q'), feed: url.searchParams.get('feed'), cursor: url.searchParams.get('cursor'), page: url.searchParams.get('page'), limit: url.searchParams.get('limit'), full: url.searchParams.get('full'), format: url.searchParams.get('format'), nocache: url.searchParams.get('nocache'), ip: resolved.ip, caller: resolved.caller }, { admission })
  pending.catch(() => undefined)
  const quota = await charged
  if (answerQuota(req, res, quota)) return true
  try {
    const result = await pending
    // As api/browse.ts: a cache hit spends no search quota, so the earlier report still holds.
    if (scope === 'search' && result.cache !== 'hit') applyRequestQuota(res, await settleRequestQuota(quota, scope, quotaCaller))
    const response = browseResponse(result, wantsJson(url.searchParams.get('format'), String(req.headers.accept ?? '')))
    res.statusCode = response.status
    for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value)
    for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
    res.end(req.method === 'HEAD' ? undefined : response.body)
  } catch (error) {
    if (error instanceof BrowseError && error.status === 404) {
      const notFound = notFoundResponse({
        instance: problemInstance(req),
        accept: url.searchParams.get('format') === 'json' ? 'application/json' : String(req.headers.accept ?? ''),
        detail: browseNotFoundDetail(resource, handle ?? url.searchParams.get('handle') ?? undefined, error.message),
        code: 'not_found',
        fallback: 'markdown',
      })
      res.statusCode = notFound.status
      for (const [key, value] of Object.entries(notFound.headers)) res.setHeader(key, value)
      res.end(req.method === 'HEAD' ? undefined : notFound.body)
      return true
    }
    if (!(error instanceof BrowseError)) console.error(error)
    if (error instanceof BrowseError && error.status === 429 && error.policy && error.retryAfter !== undefined) {
      applyExhaustedQuota(res, await settleRequestQuota(quota, scope, quotaCaller), error.policy, error.retryAfter)
    }
    respondProblem(req, res, problemFrom(error, problemInstance(req)))
  }
  return true
}

function readBody(req: IncomingMessage): Promise<ReturnType<typeof parseJsonBody>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(Buffer.from(c)))
    req.on('end', () => resolve(parseJsonBody(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', () => resolve({ ok: false }))
  })
}

async function handleAdmin(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, '')
  if (path !== '/api/admin/keys' && path !== '/api/admin/pool' && path !== '/api/admin/upstream') return false
  const methods = path === '/api/admin/pool' ? 'GET, PATCH, OPTIONS' : 'GET, POST, PATCH, DELETE, OPTIONS'
  setCorsHeaders(res, methods)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }
  if (!adminConfigured()) {
    fail(req, res, 'admin_unconfigured')
    return true
  }
  if (!adminAuthorized(req.headers)) {
    fail(req, res, 'unauthorized', 'Admin routes require a valid X-Md-Admin-Token.')
    return true
  }
  if (path === '/api/admin/upstream') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify({ upstreams: await upstreamHealth(), generatedAt: new Date().toISOString() }))
    return true
  }
  const parsed = req.method === 'GET' ? { ok: true as const, value: {} } : await readBody(req)
  if (!parsed.ok) {
    fail(req, res, 'invalid_body')
    return true
  }
  const { status, body: payload, failure } = path === '/api/admin/pool'
    ? await handlePoolApi(req.method ?? 'GET', parsed.value)
    : await handleKeysApi(req.method ?? 'GET', parsed.value)
  if (failure) {
    if (status === 405) res.setHeader('Allow', methods)
    fail(req, res, failure.code, failure.detail)
    return true
  }
  respondJson(res, status, payload)
  return true
}

/**
 * The /api/v1 rewrites from vercel.json, applied in dev so both surfaces route
 * the same way. `via=route` marks the request as rewritten, which is what keeps
 * the versioned paths out of the deprecated-alias handling.
 */
function applyVersionedRoutes(url: URL): URL {
  const path = url.pathname.replace(/\/$/, '') || '/'
  if (!path.startsWith('/api/v1/')) return url
  const routed = (destination: string, params: Record<string, string> = {}): URL => {
    const next = new URL(url.href)
    next.pathname = destination
    for (const [key, value] of Object.entries(params)) next.searchParams.set(key, value)
    next.searchParams.set('via', 'route')
    return next
  }
  const replies = path.match(/^\/api\/v1\/posts\/(\d+)\/replies$/)
  if (replies) return routed('/api/browse', { resource: 'replies', id: replies[1] })
  if (path === '/api/v1/posts') return routed('/api/convert')
  if (path === '/api/v1/search') return routed('/api/browse', { resource: 'search' })
  if (path === '/api/v1/oembed') return routed('/api/oembed')
  const posts = path.match(new RegExp(`^/api/v1/profiles/(${HANDLE})/posts$`))
  if (posts) return routed('/api/import', { handle: posts[1] ?? '' })
  const profile = path.match(new RegExp(`^/api/v1/profiles/(${HANDLE})(?:/(followers|following))?$`))
  if (profile) return routed('/api/browse', { resource: profile[2] ?? 'profile', handle: profile[1] ?? '' })
  return url
}

/**
 * Drive a read-only Vercel function from the dev server, lending the Node
 * request and response the few members the runtime adds.
 */
async function runFunction(
  handler: (req: VercelRequest, res: VercelResponse) => unknown,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const request = req as IncomingMessage & { query: Record<string, string> }
  request.query = Object.fromEntries(url.searchParams)
  const response = res as ServerResponse & { status(code: number): unknown; send(body: unknown): unknown }
  response.status = (code: number) => { res.statusCode = code; return response }
  response.send = (body: unknown) => { res.end(typeof body === 'string' ? body : JSON.stringify(body)); return response }
  await handler(request as unknown as VercelRequest, response as unknown as VercelResponse)
}

/** Bulk history (`/{handle}/posts`, and the versioned route rewritten onto /api/import) runs the real api/import.ts. */
async function handleImport(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, '')
  const permalink = path.match(new RegExp(`^/(${HANDLE})/posts$`))
  // As in production, only /docs/posts is a page (a docs file wins over the
  // rewrite); /search/posts, /api/posts and the rest are imports.
  if (path !== '/api/import' && (!permalink || permalink[1] === 'docs')) return false
  if (permalink) {
    url.searchParams.set('handle', permalink[1] ?? '')
    url.searchParams.set('via', 'route')
  }
  await runFunction(importHandler, url, req, res)
  return true
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/**
 * Drive a Vercel function from the dev server by lending the Node request and
 * response the few members the runtime adds. /mcp is a real function, so dev
 * runs its production code instead of a second implementation of the protocol.
 */
async function handleMcp(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, '')
  if (path !== '/mcp' && path !== '/mcp/server-card' && path !== '/api/mcp') return false
  if (path === '/mcp/server-card') url.searchParams.set('doc', 'server-card')

  const request = req as IncomingMessage & { query: Record<string, string>; body?: unknown; protocol?: string; documentOrigin?: string }
  request.query = Object.fromEntries(url.searchParams)
  // Self-links name the scheme this server actually speaks, and resources/read
  // fetches documents from the socket it listens on, never from the Host header.
  const { encrypted, localAddress, localPort } = req.socket as typeof req.socket & { encrypted?: boolean }
  const scheme = encrypted ? 'https' : 'http'
  request.protocol = scheme
  if (localAddress && localPort) request.documentOrigin = `${scheme}://${localAddress.includes(':') ? `[${localAddress}]` : localAddress}:${localPort}`
  if (req.method !== 'GET' && req.method !== 'HEAD') request.body = await readRawBody(req)

  const response = res as ServerResponse & {
    status(code: number): unknown
    send(body: unknown): unknown
    json(payload: unknown): unknown
  }
  response.status = (code: number) => { res.statusCode = code; return response }
  response.send = (body: unknown) => { res.end(typeof body === 'string' ? body : JSON.stringify(body)); return response }
  response.json = (payload: unknown) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify(payload))
    return response
  }

  await mcpHandler(
    request as unknown as Parameters<typeof mcpHandler>[0],
    response as unknown as Parameters<typeof mcpHandler>[1],
  )
  return true
}

async function handleApiIndex(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, '') || '/'
  if (path !== '/api' && path !== '/api/index') return false
  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  if (preflight(req, res, 'read', caller)) return true
  if (rejectMethod(req, res)) return true
  // The index is an API response like any other, so it charges the same
  // allowance the operations it describes will charge.
  if (await enforceQuota(req, res, 'read', caller)) return true
  const origin = requestOrigin(req)
  const accept = String(req.headers.accept ?? '')
  const chosen = selectRepresentation(accept, ['json', 'markdown'], 'json') ?? 'json'
  res.statusCode = 200
  res.setHeader('Content-Type', CONTENT_TYPE[chosen])
  res.setHeader('Vary', 'Accept')
  res.end(
    req.method === 'HEAD'
      ? undefined
      : chosen === 'markdown'
        ? apiIndexMarkdown(origin)
        : `${JSON.stringify(apiIndexDocument(origin), null, 2)}\n`,
  )
  return true
}

/**
 * The catch-all 404, scoped to /api in dev: Vite owns every other path, and
 * intercepting those would break the static file server.
 */
function handleApiNotFound(url: URL, req: IncomingMessage, res: ServerResponse): boolean {
  if (!url.pathname.startsWith('/api/')) return false
  setCorsHeaders(res, 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
  applyQuotaPolicyOnly(res, 'read', { ip: clientIp(req.headers) })
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }
  const path = safePath(url.pathname)
  const { status, headers, body } = notFoundResponse({
    instance: problemInstance(req),
    accept: req.headers.accept,
    path,
  })
  res.statusCode = status
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  res.end(req.method === 'HEAD' ? undefined : body)
  return true
}

function installConvertMiddleware(middlewares: Connect.Server) {
  middlewares.use((req, res, next) => {
    void (async () => {
      try {
        if (!req.url) {
          next()
          return
        }
        const url = applyVersionedRoutes(new URL(req.url, 'http://localhost'))
        const handled =
          (await handleAdmin(url, req, res)) ||
          (await handleApiIndex(url, req, res)) ||
          (await handleMcp(url, req, res)) ||
          (await handleOembed(url, req, res)) ||
          (await handleConvert(url, req, res)) ||
          (await handleImport(url, req, res)) ||
          (await handleBrowse(url, req, res)) ||
          handleApiNotFound(url, req, res)
        if (!handled) next()
      } catch (error) {
        next(error as Error)
      }
    })()
  })
}

export function apiDevPlugin(): Plugin {
  return {
    name: 'x-md-api-dev',
    enforce: 'pre',
    // Vite answers every OPTIONS in its own cors middleware, ahead of any
    // plugin, so the routes' preflight headers (quota policy, deprecation)
    // never went out locally. Keep Vite's origin policy, pass preflights on.
    config: () => ({
      server: { cors: { origin: defaultAllowedOrigins, preflightContinue: true } },
      preview: { cors: { origin: defaultAllowedOrigins, preflightContinue: true } },
    }),
    configureServer(server) {
      installConvertMiddleware(server.middlewares)
    },
    configurePreviewServer(server) {
      installConvertMiddleware(server.middlewares)
    },
  }
}
