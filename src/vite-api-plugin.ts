import type { Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { browse, browseResponse, type BrowseResource } from '../lib/browse'
import { adminAuthorized, adminConfigured } from '../lib/admin'
import { handleKeysApi, handlePoolApi } from '../lib/adminApi'
import { callerHeaders, resolveCaller } from '../lib/apiauth'
import { ConvertError as BrowseError } from '../lib/errors'
import { parseJsonBody, requestOrigin, setCorsHeaders, wantsJson, wantsMarkdown } from '../lib/http'
import {
  acceptPrefersHtml,
  ConvertError,
  convertTweet,
  markdownResponse,
} from '../lib/converter'
import { embedResponse, isEmbedUserAgent, oembedResponse } from '../lib/embed'

const HANDLE = '[A-Za-z0-9_]{1,15}'

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

/** Handles OPTIONS preflight and rejects non-GET/HEAD methods. Returns true if the request was fully handled. */
function guardMethod(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    respondJson(res, 405, { error: 'Method not allowed' })
    return true
  }
  return false
}

async function handleConvert(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = url.pathname

  const statusMatch = pathname.match(new RegExp(`^\/(${HANDLE})\/status\/(\\d+)\/?$`))
  const isApi = pathname === '/api/convert'

  if (!isApi && !statusMatch) return false

  setCorsHeaders(res)
  if (guardMethod(req, res)) return true

  const accept = String(req.headers.accept ?? '')
  const userAgent = String(req.headers['user-agent'] ?? '')
  const requestedFormat = url.searchParams.get('format')
  const asJson = wantsJson(requestedFormat, accept)
  const asMarkdown = wantsMarkdown(requestedFormat, accept)
  const asEmbed = !requestedFormat && !asJson && !asMarkdown && isEmbedUserAgent(userAgent)
  const asHtml = !requestedFormat && !asJson && !asMarkdown && !asEmbed && acceptPrefersHtml(accept)

  try {
    const result = await convertTweet({
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
    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(body)
    }
  } catch (error) {
    if (error instanceof ConvertError) {
      respondJson(res, error.status, { error: error.message, code: error.code })
    } else {
      console.error(error)
      respondJson(res, 500, { error: 'Internal converter error' })
    }
  }

  return true
}

async function handleOembed(url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (url.pathname.replace(/\/$/, '') !== '/oembed') return false
  setCorsHeaders(res)
  if (guardMethod(req, res)) return true
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
  if (path === '/api/browse') resource = (url.searchParams.get('resource') ?? undefined) as BrowseResource | undefined
  else if (path === '/search') resource = 'search'
  else {
    const match = path.match(new RegExp(`^\/(${HANDLE})(?:\/(followers|following))?$`))
    if (!match || ['api', 'docs', 'search', 'oembed'].includes(match[1] ?? '')) return false
    handle = match[1]
    resource = (match[2] as BrowseResource | undefined) ?? 'profile'
  }
  if (!resource) return false
  setCorsHeaders(res)
  if (guardMethod(req, res)) return true
  const resolved = await resolveCaller(req.headers)
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  if (resolved.status === 'invalid') {
    respondJson(res, 401, { error: 'Invalid or disabled API key.', code: 'invalid_key' })
    return true
  }
  try {
    const result = await browse({ resource, handle: handle ?? url.searchParams.get('handle'), q: url.searchParams.get('q'), feed: url.searchParams.get('feed'), cursor: url.searchParams.get('cursor'), page: url.searchParams.get('page'), limit: url.searchParams.get('limit'), full: url.searchParams.get('full'), format: url.searchParams.get('format'), nocache: url.searchParams.get('nocache'), ip: resolved.ip, caller: resolved.caller })
    const response = browseResponse(result, wantsJson(url.searchParams.get('format'), String(req.headers.accept ?? '')))
    res.statusCode = response.status
    for (const [key, value] of Object.entries(response.headers)) res.setHeader(key, value)
    for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
    res.end(req.method === 'HEAD' ? undefined : response.body)
  } catch (error) {
    if (error instanceof BrowseError) {
      if (error.status === 429 && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter))
      respondJson(res, error.status, { error: error.message, code: error.code })
    } else {
      console.error(error)
      respondJson(res, 500, { error: 'Internal browse error' })
    }
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
  if (path !== '/api/admin/keys' && path !== '/api/admin/pool') return false
  const methods = path === '/api/admin/pool' ? 'GET, PATCH, OPTIONS' : 'GET, POST, PATCH, DELETE, OPTIONS'
  setCorsHeaders(res, methods)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return true
  }
  if (!adminConfigured()) {
    respondJson(res, 503, { error: 'Admin is not configured (set X_MD_ADMIN_TOKEN).' })
    return true
  }
  if (!adminAuthorized(req.headers)) {
    respondJson(res, 401, { error: 'Unauthorized' })
    return true
  }
  const parsed = req.method === 'GET' ? { ok: true as const, value: {} } : await readBody(req)
  if (!parsed.ok) {
    respondJson(res, 400, { error: 'Invalid JSON body' })
    return true
  }
  const { status, body: payload } = path === '/api/admin/pool'
    ? await handlePoolApi(req.method ?? 'GET', parsed.value)
    : await handleKeysApi(req.method ?? 'GET', parsed.value)
  if (status === 405) res.setHeader('Allow', methods)
  respondJson(res, status, payload)
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
        const url = new URL(req.url, 'http://localhost')
        const handled =
          (await handleAdmin(url, req, res)) ||
          (await handleOembed(url, req, res)) ||
          (await handleConvert(url, req, res)) ||
          (await handleBrowse(url, req, res))
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
    configureServer(server) {
      installConvertMiddleware(server.middlewares)
    },
    configurePreviewServer(server) {
      installConvertMiddleware(server.middlewares)
    },
  }
}
