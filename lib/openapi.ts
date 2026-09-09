/**
 * The OpenAPI 3.1 description of x.md's real public API.
 *
 * Kept as TypeScript rather than hand-edited JSON so `tsc` catches drift: the
 * error codes, titles, resolutions and example bodies are generated from
 * `lib/apierror.ts` itself, and the response schemas mirror the payloads
 * `lib/converter.ts`, `lib/browse.ts` and `lib/embed.ts` actually serialise.
 * `scripts/build-openapi.ts` renders this to `public/openapi.json`, which Vite
 * copies over blume's generated docs spec at /openapi.json.
 */

import { ERROR_CATALOG, LEGACY_DEPRECATION, LEGACY_SUNSET, LEGACY_SUNSET_ISO, problemDetails } from './apierror.js'
import type { ErrorCode, ProblemDetails } from './apierror.js'

export const SITE = 'https://x.pcstyle.dev'
export const SPEC_VERSION = '1.1.0'

/**
 * ISO form of the `Deprecation` header `lib/apierror.ts` actually sends, derived
 * from it rather than restated, so the published date cannot drift from the one
 * on the wire.
 */
const LEGACY_DEPRECATION_ISO = new Date(Number(LEGACY_DEPRECATION.slice(1)) * 1000).toISOString().replace('.000Z', 'Z')

/**
 * `/api/browse` routes on its `resource` parameter, so it has no single
 * replacement: each resource is replaced by a different v1 route. Mirrors
 * `browseSuccessor()` in `api/browse.ts`, the function that emits the runtime
 * `successor-version` link, and `lib/openapi.test.ts` pins the two together.
 */
export const BROWSE_SUCCESSORS: Readonly<Record<string, string>> = {
  profile: '/api/v1/profiles/{handle}',
  followers: '/api/v1/profiles/{handle}/followers',
  following: '/api/v1/profiles/{handle}/following',
  search: '/api/v1/search',
}

/** The same mapping as prose, so the written policy cannot drift from the table. */
const BROWSE_SUCCESSOR_PROSE = Object.entries(BROWSE_SUCCESSORS)
  .map(([resource, path]) => `\`resource=${resource}\` → \`${path}\``)
  .join(', ')

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 20
const MAX_PAGE = 10

export interface JsonSchema {
  $ref?: string
  type?: string | string[]
  format?: string
  title?: string
  description?: string
  enum?: readonly (string | number | null)[]
  const?: string
  default?: string | number | boolean
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  additionalProperties?: boolean | JsonSchema
  deprecated?: boolean
  examples?: readonly (string | number)[]
}

export interface HeaderObject {
  $ref?: string
  description?: string
  schema?: JsonSchema
  example?: string | number
}

export interface MediaTypeObject {
  schema: JsonSchema
  examples?: Record<string, { $ref: string }>
}

export interface ResponseObject {
  description: string
  headers?: Record<string, HeaderObject>
  content?: Record<string, MediaTypeObject>
}

export interface ParameterObject {
  name: string
  in: 'query' | 'path'
  description: string
  required?: boolean
  schema: JsonSchema
  example?: string | number
}

export interface OperationObject {
  operationId: string
  summary: string
  description: string
  tags: readonly string[]
  parameters: readonly ParameterObject[]
  responses: Record<string, ResponseObject>
  externalDocs?: { description: string; url: string }
  security?: readonly Record<string, readonly string[]>[]
  deprecated?: boolean
  'x-sunset'?: string
  'x-deprecation'?: string
  'x-successor-version'?: string
  'x-successor-version-map'?: { parameter: string; routes: Record<string, string> }
}

export interface OpenApiDocument {
  openapi: string
  info: Record<string, unknown>
  externalDocs: { description: string; url: string }
  servers: readonly { url: string; description: string }[]
  security: readonly Record<string, readonly string[]>[]
  tags: readonly { name: string; description: string }[]
  'x-api-lifecycle': Record<string, unknown>
  'x-rate-limit-policy': readonly Record<string, unknown>[]
  'x-pagination': Record<string, unknown>
  'x-error-catalog': Record<string, unknown>
  paths: Record<string, { get: OperationObject }>
  components: {
    securitySchemes: Record<string, Record<string, string>>
    headers: Record<string, HeaderObject>
    examples: Record<string, { summary: string; value: unknown }>
    schemas: Record<string, JsonSchema>
  }
}

const schemaRef = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` })
const headerRef = (name: string): HeaderObject => ({ $ref: `#/components/headers/${name}` })
const exampleRef = (name: string): { $ref: string } => ({ $ref: `#/components/examples/${name}` })

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

/**
 * The quota headers every API response carries. Values follow
 * draft-ietf-httpapi-ratelimit-headers (RFC 9651 structured fields), with the
 * de-facto `RateLimit-Limit`/`-Remaining`/`-Reset` triple alongside for clients
 * written before the draft existed.
 */
const RATE_LIMIT_HEADERS: Record<string, HeaderObject> = {
  RateLimit: headerRef('RateLimit'),
  'RateLimit-Policy': headerRef('RateLimitPolicy'),
  'RateLimit-Limit': headerRef('RateLimitLimit'),
  'RateLimit-Remaining': headerRef('RateLimitRemaining'),
  'RateLimit-Reset': headerRef('RateLimitReset'),
}

/** RFC 9745 wants these on every response a deprecated route produces. */
function deprecationHeaders(link: 'DeprecationLink' | 'BrowseDeprecationLink'): Record<string, HeaderObject> {
  return {
    Deprecation: headerRef('Deprecation'),
    Sunset: headerRef('Sunset'),
    Link: headerRef(link),
  }
}

const COMPONENT_HEADERS: Record<string, HeaderObject> = {
  RateLimit: {
    description: 'Remaining quota and time to reset for every policy that applies, in the IETF RateLimit structured-field format.',
    schema: { type: 'string' },
    example: '"api-ip";r=599;t=41, "search-ip";r=4;t=41',
  },
  RateLimitPolicy: {
    description: 'Quota policies that apply to this request, in the IETF RateLimit structured-field format.',
    schema: { type: 'string' },
    example: '"api-ip";q=600;w=60, "search-ip";q=5;w=60',
  },
  RateLimitLimit: {
    description: 'Compatibility form of the request quota for the tightest applicable policy.',
    schema: { type: 'integer', minimum: 0 },
    example: 600,
  },
  RateLimitRemaining: {
    description: 'Compatibility form of the remaining request quota for the tightest applicable policy.',
    schema: { type: 'integer', minimum: 0 },
    example: 599,
  },
  RateLimitReset: {
    description: 'Seconds until the tightest applicable quota window resets.',
    schema: { type: 'integer', minimum: 0 },
    example: 41,
  },
  RetryAfter: {
    description: 'Seconds to wait before retrying. Takes precedence over the `t` parameter of `RateLimit`.',
    schema: { type: 'integer', minimum: 1 },
    example: 41,
  },
  Deprecation: {
    description: 'RFC 9745 deprecation date of this route, as a structured-field Date.',
    schema: { type: 'string' },
    example: LEGACY_DEPRECATION,
  },
  Sunset: {
    description: 'RFC 8594 retirement date of this route, as an HTTP-date. Never earlier than `Deprecation`.',
    schema: { type: 'string' },
    example: LEGACY_SUNSET,
  },
  DeprecationLink: {
    description: 'RFC 8288 links for the retirement: `rel="successor-version"` names the replacement route, `rel="deprecation"` and `rel="sunset"` point at the written policy.',
    schema: { type: 'string' },
    example: `<${SITE}/api/v1/posts>; rel="successor-version", <${SITE}/docs/versioning>; rel="deprecation"; type="text/html", <${SITE}/docs/versioning>; rel="sunset"; type="text/html"`,
  },
  BrowseDeprecationLink: {
    description: `RFC 8288 links for the retirement. \`rel="successor-version"\` names the replacement for this exact call, chosen by \`resource\` (${BROWSE_SUCCESSOR_PROSE}), and is absent when the request names no resolvable resource, because a Link target is a URI and never a URI Template. \`rel="deprecation"\` and \`rel="sunset"\` point at the written policy.`,
    schema: { type: 'string' },
    example: `<${SITE}/api/v1/profiles/jack/followers>; rel="successor-version", <${SITE}/docs/versioning>; rel="deprecation"; type="text/html", <${SITE}/docs/versioning>; rel="sunset"; type="text/html"`,
  },
  DiscoveryLink: {
    description: 'RFC 8288 links to this OpenAPI description, the human docs, the API catalog, the llms.txt manifest and the versioning policy.',
    schema: { type: 'string' },
    example: `<${SITE}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json", <${SITE}/docs>; rel="service-doc"; type="text/html", <${SITE}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
  },
  ProblemLink: {
    description: 'RFC 8288 links to the error reference and to this OpenAPI description.',
    schema: { type: 'string' },
    example: `<${SITE}/docs/reliability#errors>; rel="help", <${SITE}/openapi.json>; rel="service-desc"`,
  },
  Vary: {
    description: 'Representation-selecting request headers, so shared caches keep the Markdown, JSON and HTML variants apart.',
    schema: { type: 'string' },
    example: 'Accept',
  },
  CacheControl: {
    description: 'Cache directives for the response. Successful reads revalidate; problem documents are never stored.',
    schema: { type: 'string' },
    example: 'public, max-age=0, must-revalidate',
  },
  XSource: {
    description: 'Upstream provider that produced this result.',
    schema: { type: 'string', enum: ['fxtwitter', 'syndication', 'contextdev', 'firecrawl', 'xsearch'] },
  },
  XCache: {
    description: 'Whether the application cache served this response.',
    schema: { type: 'string', enum: ['HIT', 'MISS', 'BYPASS'] },
  },
  XPostCount: {
    description: 'Number of posts in the response body.',
    schema: { type: 'integer', minimum: 0 },
  },
  XWarnings: {
    description: 'Number of entries in the `warnings` array of the JSON body.',
    schema: { type: 'integer', minimum: 0 },
  },
  XConverter: {
    description: 'Always `x-md`. Identifies the service that rendered the Markdown.',
    schema: { type: 'string', const: 'x-md' },
  },
  XBrowseResource: {
    description: 'Browse resource this response answered.',
    schema: { type: 'string', enum: ['profile', 'search', 'followers', 'following'] },
  },
  XResultCount: {
    description: 'Number of posts or users in the response body.',
    schema: { type: 'integer', minimum: 0 },
  },
  XSearchDegraded: {
    description: 'Present and `true` when live X search was unavailable and web-indexed snippets were served instead.',
    schema: { type: 'string', const: 'true' },
  },
  Allow: {
    description: 'Methods this route accepts. x.md is read-only.',
    schema: { type: 'string', const: 'GET, HEAD, OPTIONS' },
  },
  XApiKeyStatus: {
    description: 'How the optional `Authorization: Bearer` key was resolved.',
    schema: { type: 'string', enum: ['anonymous', 'valid', 'invalid'] },
  },
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const HANDLE_PATTERN = '^[A-Za-z0-9_]{1,15}$'

function handleParam(location: 'path' | 'query'): ParameterObject {
  return {
    name: 'handle',
    in: location,
    description: 'X account handle without the leading `@`: 1-15 letters, digits or underscores. Reserved site paths (`/docs`, `/about`, `/search`, `/api`, ...) are never handles.',
    required: location === 'path',
    schema: { type: 'string', pattern: HANDLE_PATTERN },
    example: 'jack',
  }
}

function idParam(location: 'path' | 'query'): ParameterObject {
  return {
    name: 'id',
    in: location,
    description: 'Numeric status id of the post. On the query surface it must be paired with `handle`, and is ignored when `url` is present.',
    required: location === 'path',
    schema: { type: 'string', pattern: '^[0-9]+$' },
    example: '20',
  }
}

const URL_PARAM: ParameterObject = {
  name: 'url',
  in: 'query',
  description: 'Public x.com or twitter.com status permalink. Required unless `handle` and `id` are supplied instead.',
  required: false,
  schema: { type: 'string', format: 'uri' },
  example: 'https://x.com/jack/status/20',
}

const POST_FORMAT_PARAM: ParameterObject = {
  name: 'format',
  in: 'query',
  description: 'Output representation. Overrides `Accept` negotiation. `obsidian` emits Obsidian-flavoured Markdown with wiki links.',
  required: false,
  schema: { type: 'string', enum: ['markdown', 'obsidian', 'json'], default: 'markdown' },
}

const BROWSE_FORMAT_PARAM: ParameterObject = {
  name: 'format',
  in: 'query',
  description: 'Output representation. Overrides `Accept` negotiation. Browse routes do not support `obsidian`.',
  required: false,
  schema: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
}

const THREAD_PARAM: ParameterObject = {
  name: 'thread',
  in: 'query',
  description: 'How much of the surrounding thread to include: `off` for the single post, `full` or `conversation` for everything available, or a post count from 2 to 100.',
  required: false,
  schema: {
    type: 'string',
    pattern: '^(off|full|conversation|[2-9]|[1-9][0-9]|100)$',
    default: 'full',
  },
}

const CONTEXT_PARAM: ParameterObject = {
  name: 'context',
  in: 'query',
  description: '`full` walks parents and replies around the post; `thread` keeps only the author\'s own chain.',
  required: false,
  schema: { type: 'string', enum: ['full', 'thread'], default: 'full' },
}

const REPLIES_PARAM: ParameterObject = {
  name: 'replies',
  in: 'query',
  description: 'Which replies to include: the ranked `top` replies, the most `recent` ones, or `off`.',
  required: false,
  schema: { type: 'string', enum: ['top', 'recent', 'off'], default: 'top' },
}

const USERINFO_PARAM: ParameterObject = {
  name: 'userinfo',
  in: 'query',
  description: 'Author metadata to render into the Markdown: `off`, the thread `author` only, or `all` participants.',
  required: false,
  schema: { type: 'string', enum: ['off', 'author', 'all'], default: 'off' },
}

/**
 * The two families read booleans with different parsers: `lib/converter.ts`
 * honours `yes`, `lib/browse.ts` does not. Advertising a spelling that silently
 * reads as false is worse than not advertising it, so each family publishes the
 * spellings its own parser accepts.
 */
const POST_TRUE = ['true', '1', 'yes'] as const
const BROWSE_TRUE = ['true', '1'] as const

function booleanParam(name: string, description: string, truthy: readonly string[]): ParameterObject {
  return {
    name,
    in: 'query',
    description,
    required: false,
    schema: { type: 'string', enum: [...truthy, 'false', '0'], default: 'false' },
  }
}

const FULL_DESCRIPTION = 'Return the expanded representation: metrics, timestamps and profile counts instead of the compact default.'
const NOCACHE_DESCRIPTION = 'Bypass the application cache and fetch from the upstream provider. Charged against the live-lookup quota.'

const FULL_PARAM = booleanParam('full', FULL_DESCRIPTION, POST_TRUE)
const NOCACHE_PARAM = booleanParam('nocache', NOCACHE_DESCRIPTION, POST_TRUE)
const BROWSE_FULL_PARAM = booleanParam('full', FULL_DESCRIPTION, BROWSE_TRUE)
const BROWSE_NOCACHE_PARAM = booleanParam('nocache', NOCACHE_DESCRIPTION, BROWSE_TRUE)

const Q_PARAM: ParameterObject = {
  name: 'q',
  in: 'query',
  description: 'Search terms. X search operators such as `from:`, `since:` and `filter:` are passed through.',
  required: true,
  schema: { type: 'string', minLength: 1 },
  example: 'from:vercel release',
}

const FEED_PARAM: ParameterObject = {
  name: 'feed',
  in: 'query',
  description: 'Which search feed to read. `media` is an alias for `photos`. Unrecognised values fall back to `latest`. `photos`, `videos` and `users` need a configured live provider and answer 503 when none is available.',
  required: false,
  schema: { type: 'string', enum: ['latest', 'top', 'photos', 'videos', 'users', 'media'], default: 'latest' },
}

const CURSOR_PARAM: ParameterObject = {
  name: 'cursor',
  in: 'query',
  description: 'Opaque `nextCursor` from a previous response, and the preferred way to page. Send it back with the same query, feed and options. Never decode a cursor, edit it, or reuse it across feeds. A cursor takes precedence over `page`.',
  required: false,
  schema: { type: 'string' },
}

const PAGE_PARAM: ParameterObject = {
  name: 'page',
  in: 'query',
  description: `Ordinal page, used only when no \`cursor\` is supplied. Values above ${MAX_PAGE} are clamped. Numbered paging walks every preceding upstream page, so it is slower than a cursor.`,
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: 1 },
}

const LIMIT_PARAM: ParameterObject = {
  name: 'limit',
  in: 'query',
  description: `Maximum results in the page. Values above ${MAX_LIMIT} are clamped to ${MAX_LIMIT}.`,
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
}

/** On the legacy alias `q` only applies to `resource=search`, so it is optional there. */
const LEGACY_Q_PARAM: ParameterObject = {
  ...Q_PARAM,
  required: false,
  description: `${Q_PARAM.description} Required when \`resource=search\`.`,
}

const RESOURCE_PARAM: ParameterObject = {
  name: 'resource',
  in: 'query',
  description: 'Which browse resource to read. Each value has a dedicated `/api/v1` route that should be used instead.',
  required: true,
  schema: { type: 'string', enum: ['profile', 'search', 'followers', 'following'] },
}

const OEMBED_PARAMS: readonly ParameterObject[] = [
  {
    name: 'url',
    in: 'query',
    description: 'Status permalink the embed describes. The handle and id are read back out of it.',
    required: false,
    schema: { type: 'string', format: 'uri' },
    example: 'https://x.com/jack/status/20',
  },
  {
    name: 'text',
    in: 'query',
    description: 'Text rendered as `author_name`; x.md puts the social-proof line here.',
    required: false,
    schema: { type: 'string', maxLength: 255 },
  },
  {
    name: 'author',
    in: 'query',
    description: 'Fallback handle when `url` is absent or is not a status permalink.',
    required: false,
    schema: { type: 'string', pattern: HANDLE_PATTERN },
  },
  {
    name: 'status',
    in: 'query',
    description: 'Fallback numeric status id when `url` is absent or is not a status permalink.',
    required: false,
    schema: { type: 'string', pattern: '^[0-9]+$' },
  },
  {
    name: 'provider',
    in: 'query',
    description: 'When present, `provider_name` takes this value and `type` becomes `rich` instead of `link`.',
    required: false,
    schema: { type: 'string' },
  },
]

const POST_PARAMS: readonly ParameterObject[] = [
  URL_PARAM,
  handleParam('query'),
  idParam('query'),
  POST_FORMAT_PARAM,
  THREAD_PARAM,
  CONTEXT_PARAM,
  REPLIES_PARAM,
  USERINFO_PARAM,
  FULL_PARAM,
  NOCACHE_PARAM,
]

const LIST_PARAMS: readonly ParameterObject[] = [CURSOR_PARAM, PAGE_PARAM, LIMIT_PARAM, BROWSE_FORMAT_PARAM, BROWSE_FULL_PARAM, BROWSE_NOCACHE_PARAM]

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const SUCCESS_HEADERS: Record<string, HeaderObject> = {
  ...RATE_LIMIT_HEADERS,
  Vary: headerRef('Vary'),
  'Cache-Control': headerRef('CacheControl'),
  'X-Source': headerRef('XSource'),
  'X-Cache': headerRef('XCache'),
}

const POST_SUCCESS_HEADERS: Record<string, HeaderObject> = {
  ...SUCCESS_HEADERS,
  'X-Converter': headerRef('XConverter'),
  'X-Post-Count': headerRef('XPostCount'),
  'X-Warnings': headerRef('XWarnings'),
}

const BROWSE_SUCCESS_HEADERS: Record<string, HeaderObject> = {
  ...SUCCESS_HEADERS,
  'X-Browse-Resource': headerRef('XBrowseResource'),
  'X-Result-Count': headerRef('XResultCount'),
  'X-Api-Key-Status': headerRef('XApiKeyStatus'),
}

const SEARCH_SUCCESS_HEADERS: Record<string, HeaderObject> = {
  ...BROWSE_SUCCESS_HEADERS,
  'X-Search-Degraded': headerRef('XSearchDegraded'),
}

/** `application/json` is listed first everywhere: it is the machine default. */
function postSuccess(): ResponseObject {
  return {
    description: 'The post, its thread and the surrounding conversation. JSON carries the rendered Markdown alongside the structured posts.',
    headers: POST_SUCCESS_HEADERS,
    content: {
      'application/json': { schema: schemaRef('ConvertResponse'), examples: { post: exampleRef('postResponse') } },
      'text/markdown': { schema: { type: 'string', description: 'Rendered Markdown. The default representation.' } },
      'text/html': { schema: { type: 'string', description: 'The same Markdown wrapped in a minimal HTML page, served only to `Accept: text/html`.' } },
    },
  }
}

function browseSuccess(description: string, search: boolean): ResponseObject {
  return {
    description,
    headers: search ? SEARCH_SUCCESS_HEADERS : BROWSE_SUCCESS_HEADERS,
    content: {
      'application/json': { schema: schemaRef('BrowseResponse'), examples: search ? { search: exampleRef('searchResponse') } : { profile: exampleRef('profileResponse') } },
      'text/markdown': { schema: { type: 'string', description: 'Rendered Markdown list. The default representation. Ends with a `Continue →` link whenever `nextCursor` is set.' } },
    },
  }
}

function oembedSuccess(): ResponseObject {
  return {
    description: 'An oEmbed 1.0 document for the permalink.',
    headers: { ...RATE_LIMIT_HEADERS, 'Cache-Control': headerRef('CacheControl') },
    content: { 'application/json': { schema: schemaRef('OEmbedResponse'), examples: { oembed: exampleRef('oembedResponse') } } },
  }
}

function apiIndexSuccess(): ResponseObject {
  return {
    description: 'The API index: what x.md offers, where its machine descriptions live, every public endpoint, and every error code with its resolution.',
    headers: { ...RATE_LIMIT_HEADERS, Vary: headerRef('Vary'), 'Cache-Control': headerRef('CacheControl'), Link: headerRef('DiscoveryLink') },
    content: {
      'application/json': { schema: schemaRef('ApiIndex') },
      'text/markdown': { schema: { type: 'string', description: 'The same index as Markdown prose with YAML frontmatter, served to `Accept: text/markdown`.' } },
    },
  }
}

/** A request that really produces each documented problem, for its example. */
const PROBLEM_EXAMPLE_PATH: Partial<Record<ErrorCode, string>> = {
  invalid_handle: '/api/v1/profiles/not%20a%20handle',
  invalid_key: '/api/v1/search?q=vercel',
  invalid_resource: '/api/browse?handle=jack',
  missing_query: '/api/v1/search',
  rate_limited: '/api/v1/search?q=vercel',
  search_unavailable: '/api/v1/search?q=vercel&feed=videos',
  not_found: '/api/v1/posts?url=https://x.com/jack/status/20',
  method_not_allowed: '/api/v1/posts',
}

/** The message each documented failure really carries, copied from its throw site. */
const PROBLEM_EXAMPLE_DETAIL: Partial<Record<ErrorCode, string>> = {
  missing_url: 'Missing required `url` query parameter.',
  not_found: 'Post not found or unavailable.',
  invalid_handle: 'A valid X handle is required.',
  invalid_resource: 'Unsupported browse resource.',
  missing_query: 'Search query q is required.',
  invalid_key: 'Invalid or disabled API key.',
  method_not_allowed: 'POST is not supported on this route. x.md only reads public X content.',
  rate_limited: 'Too many live search lookups from this IP. Slow down and retry shortly.',
  upstream_error: 'All fetch providers failed.',
  search_unavailable: 'X search is temporarily unavailable upstream. Retry shortly.',
}

/**
 * Problem examples are generated by the same `problemDetails()` the handlers
 * call, so a changed title or resolution shows up in the published document
 * instead of drifting. They live in `components.examples` because the same
 * eleven documented failures repeat across fifteen operations.
 */
function problemExample(code: ErrorCode): ProblemDetails {
  return problemDetails(code, {
    instance: `${SITE}${PROBLEM_EXAMPLE_PATH[code] ?? '/api/v1/posts'}`,
    detail: PROBLEM_EXAMPLE_DETAIL[code],
    retryAfter: retryAfterFor(code),
  })
}

function retryAfterFor(code: ErrorCode): number | undefined {
  const status = ERROR_CATALOG[code].status
  return status === 429 ? 41 : status === 503 ? 30 : undefined
}

/** One typed problem response. Every documented status carries the same body. */
function problem(code: ErrorCode, recoverable: boolean): ResponseObject {
  const entry = ERROR_CATALOG[code]
  const headers: Record<string, HeaderObject> = {
    ...RATE_LIMIT_HEADERS,
    'Cache-Control': headerRef('CacheControl'),
    Link: headerRef('ProblemLink'),
  }
  if (retryAfterFor(code) !== undefined) headers['Retry-After'] = headerRef('RetryAfter')
  if (entry.status === 405) headers['Allow'] = headerRef('Allow')
  const examples = { [code]: exampleRef(code) }
  const content: Record<string, MediaTypeObject> = {
    // `application/json` first: a caller whose `Accept` names it gets exactly
    // that media type, and everyone else gets `application/problem+json`.
    'application/json': { schema: schemaRef('Problem'), examples },
    'application/problem+json': { schema: schemaRef('Problem'), examples },
  }
  // The browse family answers a miss with the same recovery document in
  // whichever representation the caller asked for, so Markdown is a real 404
  // body there and the spec has to say so.
  if (recoverable && entry.status === 404) {
    content['text/markdown'] = { schema: { type: 'string', description: 'The same recovery document as Markdown: what is missing, where to look next, and the valid URL shapes.' } }
    content['text/html'] = { schema: { type: 'string', description: 'The Markdown recovery document wrapped in a minimal HTML page.' } }
  }
  return { description: `${entry.title}. ${entry.resolution}`, headers, content }
}

function errorResponses(codes: readonly ErrorCode[], recoverable: boolean): Record<string, ResponseObject> {
  const responses: Record<string, ResponseObject> = {}
  for (const code of codes) responses[String(ERROR_CATALOG[code].status)] = problem(code, recoverable)
  return responses
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * One representative code per documented status. `problem()` turns each into a
 * typed response whose example is generated by `lib/apierror.ts` itself, so a
 * status is only documented where a handler can really produce it.
 */
const POST_ERRORS: readonly ErrorCode[] = ['missing_url', 'not_found', 'method_not_allowed', 'rate_limited', 'internal_error', 'upstream_error']
const PROFILE_ERRORS: readonly ErrorCode[] = ['invalid_handle', 'invalid_key', 'not_found', 'method_not_allowed', 'rate_limited', 'internal_error', 'upstream_error']
const SEARCH_ERRORS: readonly ErrorCode[] = ['missing_query', 'invalid_key', 'method_not_allowed', 'rate_limited', 'internal_error', 'upstream_error', 'search_unavailable']
const LEGACY_BROWSE_ERRORS: readonly ErrorCode[] = ['invalid_resource', 'invalid_key', 'not_found', 'method_not_allowed', 'rate_limited', 'internal_error', 'upstream_error', 'search_unavailable']
/** oEmbed reads nothing upstream, so it can only fail on method, quota or a bug. */
const OEMBED_ERRORS: readonly ErrorCode[] = ['method_not_allowed', 'rate_limited', 'internal_error']
const INDEX_ERRORS: readonly ErrorCode[] = ['method_not_allowed', 'rate_limited', 'internal_error']

/** Every code any operation documents, and therefore every example to publish. */
const DOCUMENTED_CODES: readonly ErrorCode[] = [
  ...new Set([...POST_ERRORS, ...PROFILE_ERRORS, ...SEARCH_ERRORS, ...LEGACY_BROWSE_ERRORS, ...OEMBED_ERRORS, ...INDEX_ERRORS]),
]

const OPTIONAL_KEY_SECURITY: readonly Record<string, readonly string[]>[] = [{}, { bearerApiKey: [] }]

interface OperationSpec {
  path: string
  operationId: string
  summary: string
  description: string
  tags: readonly string[]
  parameters: readonly ParameterObject[]
  success: ResponseObject
  errors: readonly ErrorCode[]
  docs: string
  /** Browse routes answer a miss with the recovery document in any representation. */
  recoverable404?: boolean
  security?: readonly Record<string, readonly string[]>[]
  /** Set on the two unversioned aliases scheduled for removal. */
  successor?: Successor
}

/**
 * What replaces a deprecated alias: one route, or one route per value of a
 * query parameter when the alias multiplexes several resources onto one path.
 */
type Successor = string | { parameter: string; routes: Readonly<Record<string, string>> }

function operation(spec: OperationSpec): { get: OperationObject } {
  const get: OperationObject = {
    operationId: spec.operationId,
    summary: spec.summary,
    description: spec.description,
    tags: spec.tags,
    parameters: spec.parameters,
    responses: { '200': spec.success, ...errorResponses(spec.errors, spec.recoverable404 === true) },
    externalDocs: { description: 'Endpoint documentation', url: `${SITE}/docs/${spec.docs}` },
  }
  if (spec.security) get.security = spec.security
  if (spec.successor) {
    get.deprecated = true
    get['x-deprecation'] = LEGACY_DEPRECATION_ISO
    get['x-sunset'] = LEGACY_SUNSET_ISO
    // A multiplexed alias has no single successor, so it publishes the mapping
    // instead of a `x-successor-version` that would be wrong for most callers.
    if (typeof spec.successor === 'string') get['x-successor-version'] = `${SITE}${spec.successor}`
    else {
      get['x-successor-version-map'] = {
        parameter: spec.successor.parameter,
        routes: Object.fromEntries(Object.entries(spec.successor.routes).map(([value, path]) => [value, `${SITE}${path}`])),
      }
    }
    const link = typeof spec.successor === 'string' ? 'DeprecationLink' : 'BrowseDeprecationLink'
    for (const response of Object.values(get.responses)) {
      response.headers = { ...response.headers, ...deprecationHeaders(link) }
    }
  }
  return { get }
}

const NEGOTIATION = 'Send `Accept: application/json` (or `format=json`) for the structured body, `Accept: text/markdown` for Markdown. Markdown is the default when neither is given.'

function postOperation(path: string, operationId: string, summary: string, lead: string, parameters: readonly ParameterObject[], successor?: string): { path: string; item: { get: OperationObject } } {
  return {
    path,
    item: operation({
      path,
      operationId,
      summary,
      description: `${lead}\n\nA post is returned with whatever thread and conversation context the upstream provider exposes; use \`thread\` and \`replies\` to widen or narrow it. ${NEGOTIATION} Nothing is ever written back to X.`,
      tags: ['Posts'],
      parameters,
      success: postSuccess(),
      errors: POST_ERRORS,
      docs: 'posts',
      successor,
    }),
  }
}

function profileOperation(path: string, operationId: string, summary: string, lead: string, parameters: readonly ParameterObject[]): { path: string; item: { get: OperationObject } } {
  return {
    path,
    item: operation({
      path,
      operationId,
      summary,
      description: `${lead}\n\nResults are paged: prefer the opaque \`nextCursor\` from the previous response over the ordinal \`page\`. ${NEGOTIATION}`,
      tags: ['Profiles'],
      parameters,
      success: browseSuccess('The profile and its most recent original posts, or a page of connections.', false),
      errors: PROFILE_ERRORS,
      docs: 'profiles',
      recoverable404: true,
      security: OPTIONAL_KEY_SECURITY,
    }),
  }
}

function searchOperation(path: string, operationId: string, summary: string, lead: string, parameters: readonly ParameterObject[]): { path: string; item: { get: OperationObject } } {
  return {
    path,
    item: operation({
      path,
      operationId,
      summary,
      description: `${lead}\n\nResults are paged: prefer the opaque \`nextCursor\` over the ordinal \`page\`, and send a cursor back only to the feed that issued it. When live X search is unavailable, x.md may answer with web-indexed snippets marked \`degraded: true\` and no cursor. ${NEGOTIATION}`,
      tags: ['Search'],
      parameters,
      success: browseSuccess('A page of matching posts, or of matching accounts when `feed=users`.', true),
      errors: SEARCH_ERRORS,
      docs: 'search',
      security: OPTIONAL_KEY_SECURITY,
    }),
  }
}

function oembedOperation(path: string, operationId: string, lead: string): { path: string; item: { get: OperationObject } } {
  return {
    path,
    item: operation({
      path,
      operationId,
      summary: 'oEmbed document for a status permalink',
      description: `${lead}\n\nThis is the endpoint x.md's own social-preview HTML points at with \`<link rel="alternate" type="application/json+oembed">\`. It reads no upstream data and always answers with an oEmbed 1.0 JSON document.`,
      tags: ['Embeds'],
      parameters: OEMBED_PARAMS,
      success: oembedSuccess(),
      errors: OEMBED_ERRORS,
      docs: 'responses',
    }),
  }
}

function paths(): Record<string, { get: OperationObject }> {
  const entries: { path: string; item: { get: OperationObject } }[] = [
    // Versioned surface: the stable contract for machine callers.
    postOperation(
      '/api/v1/posts',
      'getPost',
      'Read a post, thread or conversation',
      'Read one public X post as Markdown or JSON. Identify it either with `url` (a full status permalink) or with the `handle` and `id` pair.',
      POST_PARAMS,
    ),
    profileOperation(
      '/api/v1/profiles/{handle}',
      'getProfile',
      'Read a profile and its latest posts',
      'Read a public X account: its bio, counts, and its most recent original posts (replies and reposts are filtered out).',
      [handleParam('path'), ...LIST_PARAMS],
    ),
    profileOperation(
      '/api/v1/profiles/{handle}/followers',
      'listFollowers',
      'List the accounts that follow a profile',
      'Page through the accounts that follow a public X account.',
      [handleParam('path'), ...LIST_PARAMS],
    ),
    profileOperation(
      '/api/v1/profiles/{handle}/following',
      'listFollowing',
      'List the accounts a profile follows',
      'Page through the accounts a public X account follows.',
      [handleParam('path'), ...LIST_PARAMS],
    ),
    searchOperation(
      '/api/v1/search',
      'searchPosts',
      'Search public posts and accounts',
      'Search public X posts across the `latest`, `top`, `photos` and `videos` feeds, or search accounts with `feed=users`.',
      [Q_PARAM, FEED_PARAM, ...LIST_PARAMS],
    ),
    oembedOperation('/api/v1/oembed', 'getOEmbed', 'Return the oEmbed metadata a social-preview client asks for after reading an x.md permalink.'),

    // Unversioned permalink surface: the product routes, stable and not deprecated.
    postOperation(
      '/{handle}/status/{id}',
      'getPostByPermalink',
      'Read a post from its x.com permalink shape',
      'The permalink surface: swap `x.com` for `x.pcstyle.dev` in any status URL and read the same post. Media permalinks (`/photo/1`, `/video/1`) resolve to the same post.',
      [handleParam('path'), idParam('path'), POST_FORMAT_PARAM, THREAD_PARAM, CONTEXT_PARAM, REPLIES_PARAM, USERINFO_PARAM, FULL_PARAM, NOCACHE_PARAM],
    ),
    profileOperation(
      '/{handle}',
      'getProfileByHandle',
      'Read a profile from its x.com handle shape',
      'The permalink surface for accounts: `https://x.pcstyle.dev/{handle}` mirrors `https://x.com/{handle}`. Reserved site paths such as `/docs`, `/about` and `/search` are not handles.',
      [handleParam('path'), ...LIST_PARAMS],
    ),
    profileOperation(
      '/{handle}/followers',
      'listFollowersByHandle',
      'List a profile\'s followers from its permalink shape',
      'The permalink surface for followers: `https://x.pcstyle.dev/{handle}/followers`.',
      [handleParam('path'), ...LIST_PARAMS],
    ),
    profileOperation(
      '/{handle}/following',
      'listFollowingByHandle',
      'List who a profile follows from its permalink shape',
      'The permalink surface for following: `https://x.pcstyle.dev/{handle}/following`.',
      [handleParam('path'), ...LIST_PARAMS],
    ),
    searchOperation(
      '/search',
      'searchPostsByPath',
      'Search public posts from the permalink shape',
      'The permalink surface for search: `https://x.pcstyle.dev/search?q=...` mirrors `https://x.com/search?q=...`.',
      [Q_PARAM, FEED_PARAM, ...LIST_PARAMS],
    ),
    oembedOperation('/oembed', 'getOEmbedByPath', 'The permalink surface for oEmbed, and the URL x.md advertises in its own preview HTML.'),

    // Discovery.
    {
      path: '/api',
      item: operation({
        path: '/api',
        operationId: 'getApiIndex',
        summary: 'Discover the public API',
        description: 'A JSON index of everything an agent needs to start: what x.md does, where this OpenAPI document, the API catalog and the docs live, the authentication story, every public endpoint, and the machine error codes with their resolutions. Fetch this first when you have nothing but the domain.',
        tags: ['Discovery'],
        parameters: [],
        success: apiIndexSuccess(),
        errors: INDEX_ERRORS,
        docs: 'agents',
      }),
    },

    // Deprecated aliases.
    postOperation(
      '/api/convert',
      'getPostLegacy',
      'Read a post (deprecated alias)',
      `Deprecated compatibility alias for \`GET /api/v1/posts\`, kept working unchanged. Responses carry the RFC 9745 \`Deprecation\` header, the RFC 8594 \`Sunset\` header, and a \`Link\` with \`rel="successor-version"\`. Scheduled for removal on ${LEGACY_SUNSET_ISO.slice(0, 10)}; move to \`/api/v1/posts\` before then.`,
      POST_PARAMS,
      '/api/v1/posts',
    ),
    {
      path: '/api/browse',
      item: operation({
        path: '/api/browse',
        operationId: 'browseLegacy',
        summary: 'Read a profile, connections or search results (deprecated alias)',
        description: `Deprecated compatibility alias for the \`/api/v1/profiles/*\` and \`/api/v1/search\` operations, selected by the \`resource\` query parameter. Responses carry the RFC 9745 \`Deprecation\` header, the RFC 8594 \`Sunset\` header, and a \`Link\` with \`rel="successor-version"\`. Scheduled for removal on ${LEGACY_SUNSET_ISO.slice(0, 10)}; move to the versioned routes before then.\n\nThere is no single successor: the replacement depends on \`resource\` (${BROWSE_SUCCESSOR_PROSE}), and \`x-successor-version-map\` publishes the same mapping. A call that names no resolvable resource still carries \`Deprecation\` and \`Sunset\`, but no \`successor-version\` link.`,
        tags: ['Profiles', 'Search'],
        parameters: [RESOURCE_PARAM, handleParam('query'), LEGACY_Q_PARAM, FEED_PARAM, ...LIST_PARAMS],
        success: browseSuccess('The requested browse resource. The body shape depends on `resource`.', true),
        errors: LEGACY_BROWSE_ERRORS,
        docs: 'profiles',
        recoverable404: true,
        security: OPTIONAL_KEY_SECURITY,
        successor: { parameter: 'resource', routes: BROWSE_SUCCESSORS },
      }),
    },
  ]

  const items: Record<string, { get: OperationObject }> = {}
  for (const entry of entries) items[entry.path] = entry.item
  return items
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const str = (description: string): JsonSchema => ({ type: 'string', description })
const int = (description: string): JsonSchema => ({ type: 'integer', description })

function schemas(): Record<string, JsonSchema> {
  const mediaItem: JsonSchema = {
    type: 'object',
    title: 'MediaItem',
    description: 'One photo, video or animated GIF attached to a post.',
    additionalProperties: true,
    properties: {
      type: { type: 'string', description: 'Media kind reported upstream, for example `photo`, `video` or `gif`.' },
      url: { type: 'string', format: 'uri', description: 'Direct media URL.' },
      thumbnail_url: { type: 'string', format: 'uri', description: 'Poster image for a video or GIF.' },
      width: int('Pixel width.'),
      height: int('Pixel height.'),
      duration: { type: 'number', description: 'Duration in seconds, when the provider reports seconds.' },
      duration_ms: { type: 'number', description: 'Duration in milliseconds, normalised across providers.' },
      format: str('Media MIME type or container, for example `video/mp4`.'),
      bitrate: int('Bitrate in bits per second.'),
      alt: str('Alt text supplied by the author.'),
      altText: str('Alt text under the alternative key some providers use.'),
      variants: {
        type: 'array',
        description: 'Alternative encodings of a video, highest bitrate last.',
        items: {
          type: 'object',
          required: ['url'],
          additionalProperties: true,
          properties: { url: { type: 'string', format: 'uri' }, content_type: str('MIME type of the variant.'), bitrate: int('Bitrate in bits per second.') },
        },
      },
      formats: {
        type: 'array',
        description: 'Container/codec breakdown, when the provider supplies one.',
        items: {
          type: 'object',
          required: ['url'],
          additionalProperties: true,
          properties: { url: { type: 'string', format: 'uri' }, container: str('Container format.'), codec: str('Codec name.'), bitrate: int('Bitrate in bits per second.') },
        },
      },
    },
  }

  return {
    Author: {
      type: 'object',
      title: 'Author',
      description: 'A public X account. Every field is best-effort: the upstream provider decides what it exposes.',
      additionalProperties: true,
      properties: {
        id: str('Numeric account id as a string.'),
        name: str('Display name.'),
        screen_name: str('Handle without the leading `@`.'),
        url: { type: 'string', format: 'uri', description: 'Canonical x.com profile URL.' },
        description: str('Profile bio.'),
        location: str('Self-reported location.'),
        followers: int('Follower count.'),
        following: int('Following count.'),
        likes: int('Number of posts this account has liked.'),
        media_count: int('Number of posts with media.'),
        statuses: int('Total posts.'),
        joined: str('Account creation date as reported upstream.'),
        avatar_url: { type: 'string', format: 'uri', description: 'Profile image URL.' },
        banner_url: { type: 'string', format: 'uri', description: 'Profile banner URL.' },
        protected: { type: 'boolean', description: 'True when the account is private. x.md cannot read protected content.' },
        website: {
          type: 'object',
          description: 'Link in the profile header.',
          additionalProperties: true,
          properties: { url: { type: 'string', format: 'uri' }, display_url: str('Shortened form shown on the profile.') },
        },
        verification: {
          type: 'object',
          description: 'Verification badge, when the provider reports one.',
          additionalProperties: true,
          properties: { verified: { type: 'boolean' }, type: str('Badge type, for example `blue` or `business`.') },
        },
      },
    },
    MediaItem: mediaItem,
    Media: {
      type: 'object',
      title: 'Media',
      description: 'Media attached to a post, grouped by kind.',
      additionalProperties: true,
      properties: {
        photos: { type: 'array', description: 'Still images.', items: schemaRef('MediaItem') },
        videos: { type: 'array', description: 'Videos.', items: schemaRef('MediaItem') },
        animated: { type: 'array', description: 'Animated GIFs.', items: schemaRef('MediaItem') },
        all: { type: 'array', description: 'Every attachment in upstream order.', items: schemaRef('MediaItem') },
        mosaic: {
          type: 'object',
          description: 'Composite image the provider renders for multi-photo posts.',
          additionalProperties: true,
          properties: {
            type: str('Mosaic kind.'),
            photos: { type: 'array', items: schemaRef('MediaItem') },
            formats: { type: 'object', additionalProperties: true, properties: { jpeg: { type: 'string', format: 'uri' }, webp: { type: 'string', format: 'uri' } } },
          },
        },
      },
    },
    Poll: {
      type: 'object',
      title: 'Poll',
      description: 'A poll attached to a post.',
      additionalProperties: true,
      properties: {
        choices: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: { label: str('Choice text.'), count: int('Votes for this choice.'), percentage: { type: 'number', description: 'Share of the vote, 0-100.' } },
          },
        },
        total_votes: int('Total votes cast.'),
        time_left_en: str('Human-readable time remaining, in English.'),
        ends_at: str('Poll close time as reported upstream.'),
      },
    },
    Article: {
      type: 'object',
      title: 'Article',
      description: 'A long-form article attached to a post.',
      additionalProperties: true,
      properties: {
        title: str('Article title.'),
        preview_text: str('Lead paragraph or preview.'),
        content: {
          type: 'object',
          additionalProperties: true,
          properties: {
            blocks: {
              type: 'array',
              description: 'Article body in provider block form.',
              items: { type: 'object', additionalProperties: true, properties: { type: str('Block type.'), text: str('Block text.') } },
            },
          },
        },
        cover_media: {
          type: 'object',
          additionalProperties: true,
          properties: { media_info: { type: 'object', additionalProperties: true, properties: { original_img_url: { type: 'string', format: 'uri' } } } },
        },
      },
    },
    Post: {
      type: 'object',
      title: 'Post',
      description: 'One public X post. Every field is optional because the provider that answered decides what it exposes; the fallback providers return less than FxTwitter does.',
      additionalProperties: true,
      properties: {
        url: { type: 'string', format: 'uri', description: 'Canonical x.com permalink.' },
        id: str('Numeric status id as a string.'),
        text: str('Post text with entities already expanded.'),
        created_at: str('Human-readable creation time as reported upstream.'),
        created_timestamp: int('Creation time as Unix seconds.'),
        author: schemaRef('Author'),
        replies: int('Reply count.'),
        retweets: int('Repost count.'),
        reposts: int('Repost count under the newer key.'),
        likes: int('Like count.'),
        views: { type: ['integer', 'null'], description: 'View count, or null when X does not expose it.' },
        bookmarks: int('Bookmark count.'),
        quotes: int('Quote count.'),
        lang: str('BCP 47 language tag detected by X.'),
        source: str('Client the post was published from.'),
        replying_to: {
          type: ['array', 'object', 'string', 'null'],
          description: 'The post being replied to: an object with `screen_name`, `status`, `url` and `profile_url` from FxTwitter, or a legacy array of handles.',
        },
        replying_to_status: { type: ['array', 'null'], description: 'Legacy array of status ids this post replies to.', items: { type: 'string' } },
        possibly_sensitive: { type: 'boolean', description: 'X marked the media as sensitive.' },
        media: schemaRef('Media'),
        quote: schemaRef('Post'),
        reposted_by: schemaRef('Author'),
        article: schemaRef('Article'),
        poll: schemaRef('Poll'),
        community_note: { description: 'Community note attached by X, in the provider\'s own shape.' },
        context: {
          type: 'string',
          enum: ['parent', 'post', 'thread', 'reply'],
          description: 'How this post relates to the one that was requested: an ancestor (`parent`), the requested post itself (`post`), a continuation by the same author (`thread`), or a reply by someone else (`reply`).',
        },
      },
    },
    ConvertResponse: {
      type: 'object',
      title: 'ConvertResponse',
      description: 'The JSON body of a post read. Always carries both the rendered Markdown and the structured posts it was rendered from. New fields may be added inside v1, so ignore ones you do not recognise.',
      additionalProperties: true,
      required: ['format', 'url', 'markdown', 'posts', 'compact', 'warnings', 'postCount', 'source', 'cache'],
      properties: {
        format: { type: 'string', enum: ['markdown', 'obsidian', 'json'], description: 'The `format` that was requested.' },
        url: { type: 'string', format: 'uri', description: 'Canonical x.com permalink of the requested post.' },
        markdown: str('The rendered Markdown, identical to what `Accept: text/markdown` returns.'),
        posts: { type: 'array', description: 'Every post included, in reading order: ancestors first, then the requested post, then its thread and replies.', items: schemaRef('Post') },
        compact: { type: 'boolean', description: 'False when `full=true` widened the rendering.' },
        warnings: { type: 'array', description: 'Non-fatal notes, such as a truncated thread or a fallback provider. Always present, often empty.', items: { type: 'string' } },
        postCount: int('Length of `posts`.'),
        source: { type: 'string', enum: ['fxtwitter', 'syndication', 'contextdev', 'firecrawl'], description: 'Upstream provider that answered.' },
        cache: { type: 'string', enum: ['hit', 'miss', 'bypass'], description: 'Whether the application cache served this response.' },
      },
    },
    BrowseResponse: {
      type: 'object',
      title: 'BrowseResponse',
      description: 'The JSON body of a profile, connection or search read. `posts` is present for profiles and post feeds; `users` for connections and `feed=users`. Page with `nextCursor`. New fields may be added inside v1, so ignore ones you do not recognise.',
      additionalProperties: true,
      required: ['resource', 'page', 'limit', 'source', 'markdown', 'cache'],
      properties: {
        resource: { type: 'string', enum: ['profile', 'search', 'followers', 'following'], description: 'Which resource this body answers.' },
        profile: schemaRef('Author'),
        posts: { type: 'array', description: 'Matching posts. Present for `profile` and for post feeds.', items: schemaRef('Post') },
        users: { type: 'array', description: 'Matching accounts. Present for `followers`, `following` and `feed=users`.', items: schemaRef('Author') },
        query: str('The `q` that was searched. Search only.'),
        feed: { type: 'string', enum: ['latest', 'top', 'photos', 'videos', 'users'], description: 'The resolved feed. `media` is normalised to `photos`. Search only.' },
        handle: str('The account this page belongs to. Profile and connection reads only.'),
        page: { type: 'integer', minimum: 1, maximum: MAX_PAGE, description: 'Ordinal page that was served.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: 'Maximum results this page could contain.' },
        nextCursor: str('Opaque cursor for the next page. Absent when there is no continuation — including on degraded search results. Send it back as `cursor`; never decode or edit it, and never reuse it on another feed.'),
        source: { type: 'string', enum: ['fxtwitter', 'xsearch', 'firecrawl'], description: 'Upstream provider that answered.' },
        degraded: { type: 'boolean', description: 'True when live X search was unavailable and web-indexed snippets were served instead: ordering and coverage differ, text may be truncated, metrics are missing, and there is no cursor.' },
        markdown: str('The rendered Markdown, identical to what `Accept: text/markdown` returns.'),
        cache: { type: 'string', enum: ['hit', 'miss', 'bypass'], description: 'Whether the application cache served this response.' },
      },
    },
    OEmbedResponse: {
      type: 'object',
      title: 'OEmbedResponse',
      description: 'An oEmbed 1.0 document. All seven members are always present.',
      additionalProperties: true,
      required: ['author_name', 'author_url', 'provider_name', 'provider_url', 'title', 'type', 'version'],
      properties: {
        author_name: str('Text shown above the embed; x.md puts the social-proof line here.'),
        author_url: { type: 'string', format: 'uri', description: 'Canonical x.com status URL.' },
        provider_name: str('Provider label, `x.md` unless the `provider` parameter overrode it.'),
        provider_url: { type: 'string', format: 'uri', description: 'Provider link: the x.md origin, or the status URL when `provider` was supplied.' },
        title: str('Always `Embed`.'),
        type: { type: 'string', enum: ['link', 'rich'], description: '`rich` when a `provider` was supplied, otherwise `link`.' },
        version: { type: 'string', const: '1.0', description: 'oEmbed version. Always `1.0`.' },
      },
    },
    ApiIndex: {
      type: 'object',
      title: 'ApiIndex',
      description: 'The discovery document served at `/api`. Fetch it first when all you have is the domain: it names every endpoint, every error code, and every other machine description x.md publishes.',
      additionalProperties: true,
      required: ['name', 'description', 'version', 'documentation_url', 'openapi_url', 'authentication', 'versioning', 'endpoints', 'errors', 'links'],
      properties: {
        name: str('Service name.'),
        description: str('What the service does, and what it will never do.'),
        version: str('Current major version of the machine surface.'),
        documentation_url: { type: 'string', format: 'uri', description: 'Human documentation.' },
        openapi_url: { type: 'string', format: 'uri', description: 'This OpenAPI document.' },
        api_catalog_url: { type: 'string', format: 'uri', description: 'RFC 9727 API catalog.' },
        llms_txt_url: { type: 'string', format: 'uri', description: 'llms.txt manifest.' },
        mcp_url: { type: 'string', format: 'uri', description: 'MCP endpoint, for agents that speak the Model Context Protocol.' },
        terms_url: { type: 'string', format: 'uri', description: 'Terms of service.' },
        contact_url: { type: 'string', format: 'uri', description: 'How to reach the maintainer.' },
        source_url: { type: 'string', format: 'uri', description: 'Public source repository.' },
        authentication: {
          type: 'object',
          description: 'Whether credentials are needed, and what an optional key buys.',
          additionalProperties: true,
          properties: {
            required: { type: 'boolean', description: 'Always false: the public API is open.' },
            scheme: str('HTTP authentication scheme an optional key uses.'),
            description: str('What credentials do and do not change.'),
          },
        },
        versioning: {
          type: 'object',
          description: 'The same policy this document states in `info.description` and `x-api-lifecycle`.',
          additionalProperties: true,
          properties: {
            current: str('Current major version.'),
            base_path: str('Path prefix of the stable machine surface.'),
            policy_url: { type: 'string', format: 'uri', description: 'The written policy.' },
            description: str('How breaking changes and retirement are signalled.'),
            deprecated_aliases: {
              type: 'array',
              description: 'Routes scheduled for removal, with their successor and dates.',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  path: str('The deprecated route.'),
                  successor: str('What to call instead, when one route replaces the alias outright.'),
                  successor_parameter: str('Query parameter that picks the successor, when the alias multiplexes several resources onto one path.'),
                  successors: {
                    type: 'object',
                    description: 'The successor route for each value of `successor_parameter`. Present instead of `successor`.',
                    additionalProperties: { type: 'string' },
                  },
                  deprecation: str('The RFC 9745 `Deprecation` header value.'),
                  sunset: str('The RFC 8594 `Sunset` header value.'),
                  sunset_iso: str('The same retirement date in ISO 8601.'),
                },
              },
            },
          },
        },
        endpoints: {
          type: 'array',
          description: 'Every public endpoint, keyed by the same `operationId` this document uses.',
          items: {
            type: 'object',
            additionalProperties: true,
            required: ['operationId', 'method', 'path', 'description'],
            properties: {
              operationId: str('Matches an `operationId` in this OpenAPI document.'),
              method: str('HTTP method. Always `GET`; x.md is read-only.'),
              path: str('Route template.'),
              description: str('What the endpoint returns.'),
              example: { type: 'string', format: 'uri', description: 'A request that works as-is.' },
            },
          },
        },
        errors: {
          type: 'object',
          description: 'The machine error contract, with every documented code.',
          additionalProperties: true,
          properties: {
            media_type: str('Media type of a failure body.'),
            specification: { type: 'string', format: 'uri', description: 'The RFC the body follows.' },
            documentation_url: { type: 'string', format: 'uri', description: 'The error reference page.' },
            description: str('What a failure body always carries.'),
            codes: {
              type: 'array',
              description: 'Every documented code with its status and resolution.',
              items: {
                type: 'object',
                additionalProperties: true,
                required: ['code', 'status', 'resolution'],
                properties: { code: str('Stable machine code.'), status: int('HTTP status it is returned with.'), title: str('Short summary of the problem kind.'), resolution: str('What the caller should do next.') },
              },
            },
          },
        },
        links: { type: 'object', description: 'Named links to every other machine description x.md publishes.', additionalProperties: { type: 'string', format: 'uri' } },
      },
    },
    ProblemLink: {
      type: 'object',
      title: 'ProblemLink',
      description: 'A labelled link offered as a next step after a failure.',
      additionalProperties: false,
      required: ['label', 'href'],
      properties: { label: str('Human label for the link.'), href: { type: 'string', format: 'uri', description: 'Where the link points.' } },
    },
    Problem: {
      type: 'object',
      title: 'Problem',
      description: 'An RFC 9457 problem document. Every failure answers with this shape, as `application/problem+json` — or as `application/json` when the request\'s `Accept` names that type. `code` is the stable machine identifier; branch on it, not on `title` or `detail`.',
      additionalProperties: true,
      required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'resolution', 'documentation_url'],
      properties: {
        type: { type: 'string', format: 'uri', description: 'Stable URI identifying the problem kind: the error reference anchored at this `code`.' },
        title: str('Short, stable summary of the problem kind.'),
        status: { type: 'integer', minimum: 400, maximum: 599, description: 'The HTTP status code, repeated in the body.' },
        detail: str('What went wrong with this specific request.'),
        instance: { type: 'string', format: 'uri', description: 'The request URI that failed.' },
        code: {
          type: 'string',
          pattern: '^[a-z][a-z0-9_]*$',
          examples: Object.keys(ERROR_CATALOG),
          description: 'Stable machine code to branch on. Every documented code, with its status and resolution, is listed under `x-error-catalog` at the root of this document. A 502 or 503 may additionally carry a provider-specific code (`fxtwitter_error`, `firecrawl_network`, `all_providers_failed`, ...); treat any unlisted code as its status class.',
        },
        resolution: str('What the caller should do next to succeed.'),
        documentation_url: { type: 'string', format: 'uri', description: 'The error reference page.' },
        links: { type: 'array', description: 'Extra next steps, when there are any.', items: schemaRef('ProblemLink') },
        retry_after: { type: 'integer', minimum: 1, description: 'Seconds to wait before retrying. Set on 429 and 503, and mirrored in the `Retry-After` header.' },
        error: { type: 'string', deprecated: true, description: 'Alias of `detail`, kept for clients written against the pre-RFC-9457 `{error, code}` shape. Do not depend on it.' },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

const VERSIONING_POLICY = [
  'Versioning and deprecation.',
  '',
  'The stable machine surface is `/api/v1/*`, and `v1` is the current major version. Additive changes — new optional query parameters, new response fields — ship inside `v1` without a version bump, so ignore response fields you do not recognise. Breaking changes ship under a new path prefix (`/api/v2/*`), and `/api/v1/*` keeps working for at least 12 months after its successor is published.',
  '',
  'The permalink routes (`/{handle}`, `/{handle}/status/{id}`, `/{handle}/followers`, `/{handle}/following`, `/search`, `/oembed`) are the unversioned product surface. They mirror x.com URLs, they are stable, and they are not deprecated.',
  '',
  `Scheduled for deprecation on 2026-09-15: \`GET /api/convert\` (successor \`GET /api/v1/posts\`) and \`GET /api/browse\`, whose successor depends on its \`resource\` (${BROWSE_SUCCESSOR_PROSE}). Both aliases keep working unchanged until the sunset date, and they announce the schedule now, ahead of the date the \`Deprecation\` field names: every response from them carries \`Deprecation: ${LEGACY_DEPRECATION}\` (RFC 9745, an \`@\`-prefixed Unix timestamp for 2026-09-15T00:00:00Z), \`Sunset: ${LEGACY_SUNSET}\` (RFC 8594, an HTTP-date, never earlier than the deprecation date), and a \`Link\` header carrying \`rel="deprecation"\` and \`rel="sunset"\`. \`rel="successor-version"\` joins them whenever the request names a route that replaces it, which for \`/api/browse\` means a \`resource\` that resolves; a browse call that names none is answered without it. Read \`Deprecation\` and \`Sunset\` on every response, follow \`rel="successor-version"\` when it is present, and stop calling the alias before the sunset date.`,
  '',
  `Written policy: ${SITE}/docs/versioning. Machine description: ${SITE}/openapi.json.`,
].join('\n')

const DESCRIPTION = [
  'x.md is a read-only HTTP API over public X (Twitter) content. Every operation is a `GET`, none of them needs credentials, and each returns compact Markdown by default, expanded Markdown with `full=true`, or structured JSON with `format=json` or `Accept: application/json`.',
  '',
  'x.md never posts, replies, follows, likes or writes anything to X, and it cannot read protected or deleted content.',
  '',
  'Use it when an agent needs the text of a post, a thread, a profile, a follower list or a search result in a form it can parse, without running a browser or holding X credentials.',
  '',
  'Errors are RFC 9457 problem documents (`application/problem+json`, or `application/json` when the request asks for it) carrying a stable machine `code`, a human `detail`, a `resolution` telling the caller what to do next, and a `documentation_url`.',
  '',
  `Pagination is cursor-first: list responses return an opaque \`nextCursor\`; send it back as \`cursor\` with the same query and options. An ordinal \`page\` (1-${MAX_PAGE}) exists as a fallback and is slower. \`limit\` defaults to ${DEFAULT_LIMIT} and is capped at ${MAX_LIMIT}.`,
  '',
  'Quotas are advertised on every response with the IETF `RateLimit` and `RateLimit-Policy` structured fields, plus the `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` compatibility triple; a 429 also carries `Retry-After`. Cached reads do not consume the live-lookup quota.',
  '',
  VERSIONING_POLICY,
].join('\n')

/**
 * The machine error catalog, generated from `lib/apierror.ts`, so an agent can
 * plan its recovery for every documented code without probing for failures.
 */
function errorCatalog(): Record<string, unknown> {
  const codes: Record<string, unknown> = {}
  for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
    codes[code] = { status: entry.status, title: entry.title, resolution: entry.resolution, type: `${SITE}/docs/reliability#${code.replace(/_/g, '-')}` }
  }
  return {
    media_type: 'application/problem+json',
    specification: 'https://www.rfc-editor.org/rfc/rfc9457',
    documentation_url: `${SITE}/docs/reliability#errors`,
    schema: '#/components/schemas/Problem',
    note: 'A 502 or 503 may also carry a provider-specific code such as `fxtwitter_error`, `contextdev_empty`, `firecrawl_network` or `all_providers_failed`. Those share the resolution of `upstream_error`.',
    codes,
  }
}

/**
 * Shared examples: one per documented failure, plus a trimmed success body for
 * each response shape. Referenced rather than inlined, because the same eleven
 * problems repeat across fifteen operations.
 */
function componentExamples(): Record<string, { summary: string; value: unknown }> {
  const examples: Record<string, { summary: string; value: unknown }> = {
    postResponse: {
      summary: 'A single post read with thread=off',
      value: {
        format: 'markdown',
        url: 'https://x.com/jack/status/20',
        markdown: '# @jack\n\njust setting up my twttr\n\n[Source](https://x.com/jack/status/20)\n',
        posts: [
          {
            url: 'https://x.com/jack/status/20',
            id: '20',
            text: 'just setting up my twttr',
            created_at: 'Tue Mar 21 20:50:14 +0000 2006',
            created_timestamp: 1142974214,
            author: { name: 'jack', screen_name: 'jack', url: 'https://x.com/jack', followers: 6500000 },
            replies: 22000,
            retweets: 130000,
            likes: 190000,
            views: null,
            lang: 'en',
            context: 'post',
          },
        ],
        compact: true,
        warnings: [],
        postCount: 1,
        source: 'fxtwitter',
        cache: 'miss',
      },
    },
    profileResponse: {
      summary: 'A profile and its latest original posts',
      value: {
        resource: 'profile',
        profile: { name: 'jack', screen_name: 'jack', url: 'https://x.com/jack', description: 'bitcoin', followers: 6500000, following: 4000, statuses: 30000 },
        posts: [{ url: 'https://x.com/jack/status/20', id: '20', text: 'just setting up my twttr', author: { screen_name: 'jack' } }],
        handle: 'jack',
        page: 1,
        limit: 20,
        nextCursor: 'DAABCgABGtEr_XrJZ_8KAAIWfQ',
        source: 'fxtwitter',
        markdown: '# [jack (@jack)](https://x.com/jack)\n\nbitcoin\n\n## Latest posts\n- [@jack](https://x.com/jack): just setting up my twttr [Source](https://x.com/jack/status/20)\n',
        cache: 'miss',
      },
    },
    searchResponse: {
      summary: 'A page of search results, continued with nextCursor',
      value: {
        resource: 'search',
        posts: [{ url: 'https://x.com/vercel/status/1', id: '1', text: 'Shipping today.', author: { screen_name: 'vercel' } }],
        query: 'from:vercel release',
        feed: 'latest',
        page: 1,
        limit: 20,
        nextCursor: 'xsearch:DAADDAABCgABGtEr_XrJZ_8',
        source: 'xsearch',
        markdown: '# X search: from:vercel release\n\n- [@vercel](https://x.com/vercel): Shipping today. [Source](https://x.com/vercel/status/1)\n',
        cache: 'miss',
      },
    },
    oembedResponse: {
      summary: 'oEmbed metadata for a status permalink',
      value: {
        author_name: '\ud83d\udcac 22.0K   \ud83d\udd01 130.0K   \u2764\ufe0f 190.0K',
        author_url: 'https://x.com/jack/status/20',
        provider_name: 'x.md',
        provider_url: SITE,
        title: 'Embed',
        type: 'link',
        version: '1.0',
      },
    },
  }
  for (const code of DOCUMENTED_CODES) {
    examples[code] = { summary: ERROR_CATALOG[code].title, value: problemExample(code) }
  }
  return examples
}

export function openapiDocument(): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: {
      title: 'x.md API',
      version: SPEC_VERSION,
      summary: 'Read public X posts, threads, profiles, connections and search results as Markdown or JSON.',
      description: DESCRIPTION,
      termsOfService: `${SITE}/terms`,
      license: { name: 'MIT', identifier: 'MIT' },
      contact: { name: 'x.md maintainer', url: `${SITE}/contact` },
    },
    externalDocs: { description: 'x.md documentation: endpoints, pagination, response shapes, error codes and quotas', url: `${SITE}/docs` },
    servers: [
      { url: SITE, description: 'x.md production' },
      { url: 'https://mdfromx.com', description: 'x.md production (parallel domain)' },
    ],
    security: [],
    tags: [
      { name: 'Posts', description: 'Read a single post, its thread, and the conversation around it.' },
      { name: 'Profiles', description: 'Read a public account, its recent original posts, its followers and who it follows.' },
      { name: 'Search', description: 'Search public posts and accounts across the latest, top, photos, videos and users feeds.' },
      { name: 'Embeds', description: 'oEmbed metadata for x.md permalinks.' },
      { name: 'Discovery', description: 'Machine-readable entry points into the API.' },
    ],
    'x-api-lifecycle': {
      current_major_version: 'v1',
      supported_versions: ['v1'],
      minimum_support_window_months: 12,
      versioning_scheme: 'url-path',
      deprecation_signals: ['Deprecation', 'Sunset', 'Link; rel="successor-version"'],
      deprecation_policy_url: `${SITE}/docs/versioning`,
      policy: VERSIONING_POLICY,
      deprecated_operations: [
        { operationId: 'getPostLegacy', path: '/api/convert', deprecated: LEGACY_DEPRECATION_ISO, sunset: LEGACY_SUNSET_ISO, successor: '/api/v1/posts' },
        { operationId: 'browseLegacy', path: '/api/browse', deprecated: LEGACY_DEPRECATION_ISO, sunset: LEGACY_SUNSET_ISO, successor_parameter: 'resource', successors: BROWSE_SUCCESSORS },
      ],
    },
    'x-rate-limit-policy': [
      { name: 'api-ip', quota: 600, window_seconds: 60, partition: 'client IP address', applies_to: 'every public API route' },
      { name: 'search-ip', quota: 5, window_seconds: 60, partition: 'client IP address', applies_to: 'live search lookups by anonymous callers', notes: 'Charged only when a request misses the cache and reaches an upstream provider.' },
      { name: 'search-key', quota: 30, window_seconds: 60, partition: 'API key', applies_to: 'live search lookups by key holders' },
      { name: 'account-ip', quota: 10, window_seconds: 900, partition: 'client IP address', applies_to: 'account-backed search feeds (photos, videos, users)', notes: 'A shared public pool; key holders draw from their own allowance instead.' },
      // `lib/ratelimit-headers.ts` advertises this one to key holders with the
      // key's own quota, so it appears in `RateLimit-Policy` without a fixed `q`.
      { name: 'account-key', quota: null, window_seconds: 900, partition: 'API key', applies_to: 'account-backed search feeds for key holders', notes: 'The quota is set per key when it is issued; read it from the `q` parameter of `RateLimit-Policy`.' },
    ],
    'x-error-catalog': errorCatalog(),
    'x-pagination': {
      style: 'cursor',
      preferred: 'cursor',
      request_parameters: { cursor: 'cursor', page: 'page', limit: 'limit' },
      response_fields: { next_cursor: 'nextCursor', page: 'page', limit: 'limit' },
      default_limit: DEFAULT_LIMIT,
      max_limit: MAX_LIMIT,
      max_page: MAX_PAGE,
      cursor_opacity: 'opaque',
      termination: 'Stop when `nextCursor` is absent. A short or empty page is not the end of the list.',
      notes: 'Cursors are provider-tagged. Return one only to the same route, query and feed that issued it. Degraded search results carry no cursor.',
    },
    paths: paths(),
    components: {
      securitySchemes: {
        bearerApiKey: {
          type: 'http',
          scheme: 'bearer',
          description: 'Optional. The public API needs no credentials; an issued key raises the live-search allowance and keeps responses out of the shared cache. Keys are handed out by the maintainer through GitHub issues, not self-service.',
        },
      },
      headers: COMPONENT_HEADERS,
      examples: componentExamples(),
      schemas: schemas(),
    },
  }
}

/** The canonical serialization committed to `public/openapi.json`. */
export function openapiJson(): string {
  return `${JSON.stringify(openapiDocument(), null, 2)}\n`
}
