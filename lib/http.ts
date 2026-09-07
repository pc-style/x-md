/** Minimal shape shared by Vercel's response object and Node's ServerResponse. */
export interface HeaderWriter {
  setHeader(name: string, value: string): void
}

export interface OriginRequest {
  headers: {
    host?: string | string[]
    'x-forwarded-proto'?: string | string[]
    'x-forwarded-host'?: string | string[]
  }
  protocol?: string
  socket?: unknown
}

const PUBLIC_EMBED_HOSTS = new Set(['x.pcstyle.dev', 'x-md.vercel.app'])

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function hostnameOf(host: string | undefined): string | undefined {
  if (!host) return undefined
  return host.split(',')[0]?.trim().replace(/:\d+$/, '') || undefined
}

function requestProtocol(req: OriginRequest): 'http' | 'https' {
  const forwarded = headerValue(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim().toLowerCase()
  if (forwarded === 'http' || forwarded === 'https') return forwarded
  if (req.protocol === 'http:' || req.protocol === 'http') return 'http'
  if (req.socket && typeof req.socket === 'object' && 'encrypted' in req.socket && req.socket.encrypted) {
    return 'https'
  }
  return 'https'
}

export function requestOrigin(req: OriginRequest, fallback = 'https://x.pcstyle.dev'): string {
  const hostHeader = headerValue(req.headers.host)
  const hostname = hostnameOf(hostHeader)
  if (hostname && (PUBLIC_EMBED_HOSTS.has(hostname) || hostname === 'localhost' || hostname === '127.0.0.1')) {
    return `${requestProtocol(req)}://${hostHeader}`
  }
  return fallback
}

export function setCorsHeaders(res: HeaderWriter, methods = 'GET, HEAD, OPTIONS'): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Authorization')
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Api-Key-Status')
}

type HeaderBag = Record<string, string | string[] | undefined>

/**
 * The API secret a caller presented via `Authorization: Bearer`. Only that
 * header is honored: the CDN never caches Authorization requests, which keeps
 * keyed responses out of the shared cache.
 */
export function presentedApiKey(headers: HeaderBag): string | undefined {
  const auth = headerValue(headers['authorization'])
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim() || undefined
  return undefined
}

/** Parse a JSON request body; empty is `{}`, malformed is rejected so callers can 400. */
export function parseJsonBody(raw: unknown): { ok: true; value: unknown } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} }
  if (typeof raw !== 'string') return { ok: true, value: raw }
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return { ok: false }
  }
}

export function wantsJson(format: string | null | undefined, accept: string): boolean {
  if (format) return format === 'json'
  return accept.includes('application/json')
}

export function wantsMarkdown(format: string | null | undefined, accept: string): boolean {
  if (format) return format === 'markdown' || format === 'obsidian'
  return accept.includes('text/markdown')
}
