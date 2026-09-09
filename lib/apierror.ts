/**
 * RFC 9457 problem details for every API error.
 *
 * Agents cannot act on an HTML error page, and `{error, code}` alone does not
 * say what to do next. Every failure now answers with a stable machine `code`,
 * a human `detail`, a `resolution` hint, and a link to the docs. The legacy
 * `error` field is kept as an alias so existing callers keep working.
 */

import { ConvertError } from './errors.js'
import { mediaQuality } from './negotiate.js'
import { noteRequestError } from './server-events.js'

const SITE = 'https://x.pcstyle.dev'
const REPO = 'https://github.com/pc-style/x-md'

/** Every `documentation_url` anchors here; each `type` is a fragment on it. */
export const ERRORS_DOC = `${SITE}/docs/reliability#errors`

export interface ProblemLink {
  label: string
  href: string
}

/** RFC 9457 problem details plus the extension members x.md documents. */
export interface ProblemDetails {
  type: string
  title: string
  status: number
  detail: string
  instance: string
  code: string
  resolution: string
  documentation_url: string
  links?: ProblemLink[]
  retry_after?: number
  /** Alias of `detail`, kept for clients written against the old shape. */
  error?: string
}

interface CatalogEntry {
  status: number
  title: string
  resolution: string
}

/** Every machine code x.md can emit: its stable title and how to recover. */
export const ERROR_CATALOG = {
  missing_url: {
    status: 400,
    title: 'Missing url parameter',
    resolution: 'Add `?url=<public X status URL>`, or call `/{handle}/status/{id}` directly.',
  },
  invalid_url: {
    status: 400,
    title: 'Invalid X status URL',
    resolution: 'Pass a public x.com or twitter.com status URL in `url`, for example `?url=https://x.com/jack/status/20`.',
  },
  unsupported_host: {
    status: 400,
    title: 'Unsupported host',
    resolution: 'Only x.com and twitter.com status URLs are supported. Rewrite the host and retry.',
  },
  invalid_path: {
    status: 400,
    title: 'Not a status permalink',
    resolution: 'Use a permalink shaped like https://x.com/{handle}/status/{id}.',
  },
  invalid_params: {
    status: 400,
    title: 'Invalid handle or status id',
    resolution: 'Provide `handle` (1-15 word characters) and a numeric `id`.',
  },
  invalid_handle: {
    status: 400,
    title: 'Invalid X handle',
    resolution: 'Handles are 1-15 characters of letters, digits, or underscores, with no leading @.',
  },
  invalid_resource: {
    status: 400,
    title: 'Unsupported browse resource',
    resolution: 'Use `resource=profile`, `search`, `followers`, or `following`.',
  },
  invalid_format: {
    status: 400,
    title: 'Unsupported format',
    resolution: 'Use `format=markdown`, `format=obsidian`, or `format=json`. Browse accepts markdown or json.',
  },
  invalid_thread: {
    status: 400,
    title: 'Invalid thread parameter',
    resolution: 'Use `thread=off`, `full`, `conversation`, or a number from 2 to 100.',
  },
  invalid_userinfo: {
    status: 400,
    title: 'Invalid userinfo parameter',
    resolution: 'Use `userinfo=off`, `author`, or `all`.',
  },
  invalid_context: {
    status: 400,
    title: 'Invalid context parameter',
    resolution: 'Use `context=full` or `context=thread`.',
  },
  invalid_replies: {
    status: 400,
    title: 'Invalid replies parameter',
    resolution: 'Use `replies=top`, `recent`, or `off`.',
  },
  invalid_mode: {
    status: 400,
    title: 'Invalid mode parameter',
    resolution: `See the parameter tables at ${SITE}/docs/responses.`,
  },
  missing_query: {
    status: 400,
    title: 'Missing search query',
    resolution: 'Add `?q=<search terms>`, for example `/search?q=vercel`.',
  },
  invalid_body: {
    status: 400,
    title: 'Invalid JSON body',
    resolution: 'Send a well-formed JSON object, or omit the body entirely.',
  },
  invalid_key: {
    status: 401,
    title: 'Invalid or disabled API key',
    resolution: 'Remove the Authorization header to call anonymously, or present a valid `Authorization: Bearer <key>`.',
  },
  unauthorized: {
    status: 401,
    title: 'Unauthorized',
    resolution: `This route is private. The public read-only API needs no credentials; see ${SITE}/openapi.json.`,
  },
  not_found: {
    status: 404,
    title: 'Not found',
    resolution: 'Confirm the post or profile is public and still exists on x.com, then retry. Deleted and protected content is never available.',
  },
  route_not_found: {
    status: 404,
    title: 'API route not found',
    resolution: `Discover the public API through ${SITE}/api, ${SITE}/openapi.json, or ${SITE}/.well-known/api-catalog.`,
  },
  method_not_allowed: {
    status: 405,
    title: 'Method not allowed',
    resolution: 'x.md is read-only. Use GET, HEAD, or OPTIONS; the `Allow` response header lists what this route accepts.',
  },
  not_acceptable: {
    status: 406,
    title: 'No acceptable representation',
    resolution: 'Request `text/markdown`, `application/json`, or `text/html`, or omit the Accept header.',
  },
  rate_limited: {
    status: 429,
    title: 'Rate limit exceeded',
    resolution: 'Wait the number of seconds in the `Retry-After` header, then retry. Cached responses do not count against the allowance.',
  },
  internal_error: {
    status: 500,
    title: 'Unexpected error',
    resolution: `Retry with exponential backoff. If it persists, open an issue at ${REPO}/issues.`,
  },
  upstream_error: {
    status: 502,
    title: 'Upstream provider error',
    resolution: 'Retry with backoff. x.md reads a third-party provider that can fail independently.',
  },
  upstream_rate_limited: {
    status: 503,
    title: 'Upstream provider is rate limiting x.md',
    resolution: 'Wait the number of seconds in `Retry-After`, then retry. Bulk imports back off per page automatically; lower `concurrency` if this repeats.',
  },
  search_unavailable: {
    status: 503,
    title: 'Search temporarily unavailable',
    resolution: 'Wait the number of seconds in `Retry-After`, then retry. Photos, Videos, and Users need configured sessions.',
  },
  admin_unconfigured: {
    status: 503,
    title: 'Admin is not configured',
    resolution: 'Set X_MD_ADMIN_TOKEN on the deployment. This route is not part of the public API.',
  },
} as const satisfies Record<string, CatalogEntry>

export type ErrorCode = keyof typeof ERROR_CATALOG

/**
 * The provider layer raises codes the published catalogue does not name
 * (`private_tweet`, `fxtwitter_error`, `all_providers_failed`, ...). openapi.json
 * tells clients to treat an unlisted code as its status class, so that is what
 * decides its title, type, and resolution: a 404 must never read "Unexpected
 * error, open an issue".
 */
export function codeForStatus(status: number): ErrorCode {
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate_limited'
  if (status === 503) return 'search_unavailable'
  if (status === 500 || status < 500) return 'internal_error'
  return 'upstream_error'
}

function catalogEntry(code: string, status?: number): { code: ErrorCode; entry: CatalogEntry } {
  const listed = (ERROR_CATALOG as Record<string, CatalogEntry>)[code]
  if (listed) return { code: code as ErrorCode, entry: listed }
  const klass = codeForStatus(status ?? 500)
  return { code: klass, entry: ERROR_CATALOG[klass] }
}

export interface ProblemInit {
  /** Absolute URL of the request that failed. */
  instance: string
  /** Occurrence-specific message; defaults to the catalog title. */
  detail?: string
  /** Overrides the catalog status (a ConvertError carries its own). */
  status?: number
  retryAfter?: number
  links?: ProblemLink[]
}

/**
 * Bound the human `detail` before it goes out.
 *
 * It can carry an upstream exception message, so it is caller-influenced text
 * echoed back under our own domain. Control characters and angle brackets are
 * dropped — an error sentence needs neither — and the length is capped so a
 * failing provider cannot turn a 502 into a content host.
 */
function safeDetail(value: string, max = 400): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}\u2026` : cleaned
}

export function problemDetails(code: string, init: ProblemInit): ProblemDetails {
  // `code` is reported as raised so a caller can log the provider that failed;
  // everything an agent acts on comes from the documented type it maps to.
  const { code: documented, entry } = catalogEntry(code, init.status)
  const detail = safeDetail(init.detail ?? entry.title) || entry.title
  const problem: ProblemDetails = {
    type: `${SITE}/docs/reliability#${documented.replace(/_/g, '-')}`,
    title: entry.title,
    status: init.status ?? entry.status,
    detail,
    instance: init.instance,
    code,
    resolution: entry.resolution,
    documentation_url: ERRORS_DOC,
    error: detail,
  }
  if (init.retryAfter !== undefined) problem.retry_after = init.retryAfter
  if (init.links?.length) problem.links = init.links
  return problem
}

const PROBLEM_JSON = 'application/problem+json'

/**
 * `application/problem+json` by default. A caller that asks for
 * `application/json` specifically gets exactly that, so clients matching on the
 * literal type still recognise the body.
 *
 * The two types are weighed through the RFC 9110 parser, not by substring, so
 * `application/problem+json;q=0, application/json` honours the rejection. They
 * stay out of negotiate's `Repr` union, which is the set of representations a
 * page renders as; these are two encodings of one error body.
 */
export function problemMediaType(accept: string): string {
  const problem = mediaQuality(accept, PROBLEM_JSON)
  const plain = mediaQuality(accept, 'application/json')
  // An error body is never withheld over Accept, so anything short of a caller
  // ranking plain JSON above problem+json keeps the documented default.
  if (plain && plain.q > 0 && (!problem || problem.q === 0 || plain.q > problem.q)) return 'application/json'
  return PROBLEM_JSON
}

export interface ProblemResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export function problemResponse(problem: ProblemDetails, accept: string): ProblemResponse {
  const headers: Record<string, string> = {
    'Content-Type': `${problemMediaType(accept)}; charset=utf-8`,
    'Cache-Control': 'no-store',
    Vary: 'Accept',
    Link: `<${ERRORS_DOC}>; rel="help", <${SITE}/openapi.json>; rel="service-desc"`,
  }
  if (problem.retry_after !== undefined) headers['Retry-After'] = String(problem.retry_after)
  return { status: problem.status, headers, body: `${JSON.stringify(problem, null, 2)}\n` }
}

/** Map anything the lib layer throws onto a problem document. */
export function problemFrom(error: unknown, instance: string): ProblemDetails {
  if (error instanceof ConvertError) {
    return problemDetails(error.code ?? codeForStatus(error.status), {
      instance,
      detail: error.message,
      status: error.status,
      retryAfter: error.retryAfter ?? (error.status === 429 ? 60 : error.status === 503 ? 30 : undefined),
    })
  }
  return problemDetails('internal_error', { instance })
}

/** Absolute `instance` URI for the failing request. */
export function requestInstance(req: { url?: string }, origin: string): string {
  try {
    return new URL(req.url ?? '/', origin).toString()
  } catch {
    return origin
  }
}

/** A response object that can report the headers already written to it. */
export interface HeaderSink {
  setHeader(name: string, value: string): void
  getHeader?(name: string): number | string | string[] | undefined
}

/**
 * Add to `Link` rather than replace it: deprecation, help and service-description
 * links are set by different layers of the same response.
 */
export function appendLink(res: HeaderSink, ...links: string[]): void {
  const current = res.getHeader?.('Link')
  const existing = Array.isArray(current) ? current.map(String) : current ? [String(current)] : []
  const merged = [...existing, ...links].filter((link, index, all) => all.indexOf(link) === index)
  res.setHeader('Link', merged.join(', '))
}

/** Write a problem response onto a Vercel/Node response object. */
export function sendProblem(
  res: HeaderSink & {
    status(code: number): { send(body: string): unknown; end(): unknown }
  },
  problem: ProblemDetails,
  accept: string,
  method = 'GET',
): unknown {
  noteRequestError(res, problem.code, problem.status)
  const response = problemResponse(problem, accept)
  for (const [key, value] of Object.entries(response.headers)) {
    if (key === 'Link') appendLink(res, value)
    else res.setHeader(key, value)
  }
  const out = res.status(response.status)
  return method === 'HEAD' ? out.end() : out.send(response.body)
}

/**
 * RFC 9745 `Deprecation`: an Item Structured Field of type Date, `@` plus Unix
 * seconds. 2026-09-15T00:00:00Z, when the unversioned aliases were superseded.
 */
export const LEGACY_DEPRECATION = '@1789430400'
/** RFC 8594 `Sunset`: an HTTP-date. Never earlier than the Deprecation date. */
export const LEGACY_SUNSET = 'Wed, 15 Sep 2027 00:00:00 GMT'
/** ISO form of `LEGACY_SUNSET`, for JSON documents. */
export const LEGACY_SUNSET_ISO = '2027-09-15T00:00:00Z'
/** Where the versioning and deprecation policy is written down. */
export const VERSIONING_DOC = `${SITE}/docs/versioning`

/**
 * Mark a response as coming from a deprecated route. RFC 9745 expects these on
 * every response the deprecated resource produces, errors included, so callers
 * set them before anything else can return.
 */
export function setDeprecationHeaders(res: HeaderSink, successorPath?: string): void {
  res.setHeader('Deprecation', LEGACY_DEPRECATION)
  res.setHeader('Sunset', LEGACY_SUNSET)
  appendLink(
    res,
    // A Link target is a URI, never a URI Template, so a successor is advertised
    // only when this request names a concrete one.
    ...(successorPath ? [`<${SITE}${successorPath}>; rel="successor-version"`] : []),
    `<${VERSIONING_DOC}>; rel="deprecation"; type="text/html"`,
    `<${VERSIONING_DOC}>; rel="sunset"; type="text/html"`,
  )
}
