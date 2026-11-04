import { MEDIA, mediaQuality, selectRepresentation, type Repr } from './negotiate.js'

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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
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

export function requestOrigin(req: OriginRequest, fallback = 'https://mdfromx.com'): string {
  // Vercel routes only attached domains here. Do not trust x-forwarded-host,
  // and validate the authority before reflecting it into HTML or documents.
  const host = headerValue(req.headers.host)
  if (host && /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\])(?::[0-9]{1,5})?$/i.test(host)) {
    try { return new URL(`${requestProtocol(req)}://${host}`).origin } catch { /* invalid authority */ }
  }
  return fallback
}

export function setCorsHeaders(res: HeaderWriter, methods = 'GET, HEAD, OPTIONS'): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', methods)
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type, Authorization')
  // vercel.json publishes the same list, but its `source` matches the INCOMING
  // path, so the permalink routes (/{handle}, /{handle}/status/{id}) miss it.
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Api-Key-Status, RateLimit, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Deprecation, Sunset, Link, X-Source, X-Cache, X-Result-Count, X-Search-Degraded, X-Archive-Served, X-Archive-Store')
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

const DATA_OFFERS: readonly Repr[] = ['json', 'markdown']

/**
 * The representation an Accept header asks for among `offers`, through the RFC
 * 9110 parser so `q=0` is a refusal rather than a match. Only types the caller
 * named itself compete, so a wildcard cannot outrank them; earlier offers win
 * ties. Undefined when it named none of them (no header, bare wildcards, or
 * nothing offered), which leaves the route its Markdown default and the
 * preview-bot path, unless the header refuses Markdown: then the best offer a
 * wildcard still reaches, or null when it refuses every offer (a 406).
 */
export function acceptedRepresentation(accept: string, offers: readonly Repr[] = DATA_OFFERS): Repr | undefined | null {
  const named = offers.filter((offer) => {
    const match = mediaQuality(accept, MEDIA[offer])
    return match?.exact && match.q > 0
  })
  if (named.length > 0) return selectRepresentation(accept, named, named[0]!) ?? undefined
  if (mediaQuality(accept, MEDIA.markdown)?.q !== 0) return undefined
  return selectRepresentation(accept, offers, 'markdown')
}

export function wantsJson(format: string | null | undefined, accept: string, offers: readonly Repr[] = DATA_OFFERS): boolean {
  if (format) return format === 'json'
  return acceptedRepresentation(accept, offers) === 'json'
}

export function wantsMarkdown(format: string | null | undefined, accept: string, offers: readonly Repr[] = DATA_OFFERS): boolean {
  if (format) return format === 'markdown' || format === 'obsidian'
  return acceptedRepresentation(accept, offers) === 'markdown'
}
