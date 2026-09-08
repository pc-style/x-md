import { browse, type BrowseResult } from './browse.js'
import { convertTweet } from './converter.js'
import { ConvertError } from './errors.js'
import type { SearchCaller } from './xsearch.js'

export const MCP_SERVER_NAME = 'io.github.pc-style/x-md'
export const MCP_SERVER_TITLE = 'x.md'
export const MCP_SERVER_VERSION = '1.0.0'
export const MCP_SITE = 'https://x.pcstyle.dev'
export const MCP_ENDPOINT = `${MCP_SITE}/mcp`
export const MCP_DOCS_URL = `${MCP_SITE}/docs/mcp`
export const MCP_SERVER_DESCRIPTION = 'Read public X posts, threads, profiles, and search results as Markdown or JSON.'

/**
 * Two protocol eras, both live.
 *
 * "Modern" (2026-07-28 and later) is stateless: there is no `initialize`
 * handshake, every request carries its own version in `_meta`, and results
 * carry `resultType` plus caching hints. "Legacy" (2025-11-25 and earlier)
 * negotiates once through `initialize`. This server mints no session either
 * way, which is exactly the stateless core the modern era standardised, so
 * both eras run through the same dispatch.
 */
export const MCP_MODERN_PROTOCOL = '2026-07-28'
/** The newest revision answered to a legacy `initialize` that asks for something we do not speak. */
export const MCP_LATEST_LEGACY_PROTOCOL = '2025-11-25'
/** The handshake era, newest first. Only these can come back from `initialize`. */
export const MCP_LEGACY_PROTOCOLS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26']
export const MCP_SUPPORTED_PROTOCOLS: readonly string[] = [MCP_MODERN_PROTOCOL, ...MCP_LEGACY_PROTOCOLS]

export const JSONRPC_PARSE_ERROR = -32700
export const JSONRPC_INVALID_REQUEST = -32600
export const JSONRPC_METHOD_NOT_FOUND = -32601
export const JSONRPC_INVALID_PARAMS = -32602
export const JSONRPC_INTERNAL_ERROR = -32603
/**
 * -32020..-32099 is the range 2026-07-28 reserves for the specification itself;
 * the three below are the ones a stateless HTTP server can raise.
 */
export const MCP_HEADER_MISMATCH = -32020
export const MCP_MISSING_CAPABILITY = -32021
export const MCP_UNSUPPORTED_PROTOCOL_VERSION = -32022
/**
 * 2026-07-28 moved "resource not found" from -32002 onto plain Invalid Params
 * to line up with JSON-RPC. Legacy clients accepted -32002, but -32602 is a
 * standard code they already understand, so both eras get the same one.
 */
export const MCP_RESOURCE_NOT_FOUND = JSONRPC_INVALID_PARAMS

export const MCP_INSTRUCTIONS = [
  'x.md reads PUBLIC X (formerly Twitter) content without an X account, an X API key, or a login.',
  'Use x_md_get_post when you have an x.com or twitter.com status link and need its text, author, media, metrics, quoted post, or replies.',
  'Use x_md_get_profile to learn who an account is and what it has posted recently.',
  'Use x_md_search_posts to find current public discussion on a topic or to locate an account by name.',
  'Use x_md_get_followers and x_md_get_following to page through an account’s public connections.',
  'Every tool is read-only: none of them post, reply, like, follow, or read protected accounts, direct messages, or Lists.',
  'Paging is page- and cursor-based; limit is capped at 20 per call and page at 10, so walk deep result sets with next_cursor.',
  'Live search is rate limited per IP. A 429 comes back as an isError result naming the seconds to wait, not as a transport failure.',
].join(' ')

export interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface McpToolAnnotations {
  title: string
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface McpTool {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  annotations: McpToolAnnotations
}

export interface McpResource {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
}

export interface McpContext {
  ip?: string
  caller?: SearchCaller
  /** Which revision the request declared; decides which methods exist. */
  era?: 'modern' | 'legacy'
}

export type DispatchOutcome = { result: unknown } | { error: JsonRpcError } | null

/** Every tool reads live third-party data and changes nothing, so the hints never vary. */
const READ_ONLY: Omit<McpToolAnnotations, 'title'> = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
}

const DRAFT = 'https://json-schema.org/draft/2020-12/schema'

const HANDLE_PROPERTY = {
  type: 'string',
  pattern: '^@?[A-Za-z0-9_]{1,15}$',
  description: 'X handle, with or without the leading @. For example `pcstyle53` or `@pcstyle53`.',
}

const PAGING_PROPERTIES = {
  page: {
    type: 'integer',
    minimum: 1,
    maximum: 10,
    default: 1,
    description: 'Page of results, starting at 1. The service caps this at 10; use cursor to go deeper.',
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 20,
    default: 20,
    description: 'Results per page. The service caps this at 20.',
  },
  cursor: {
    type: 'string',
    maxLength: 1024,
    description: 'Opaque continuation token returned as next_cursor by a previous call. Prefer it over page for deep pagination.',
  },
  full: {
    type: 'boolean',
    default: false,
    description: 'Return the verbose rendering with full metrics and media detail instead of the compact one.',
  },
}

const AUTHOR_DEF = {
  type: 'object',
  description: 'A public X account. Fields are omitted when the upstream source does not supply them.',
  properties: {
    id: { type: 'string' },
    name: { type: 'string', description: 'Display name.' },
    screen_name: { type: 'string', description: 'Handle without the @.' },
    url: { type: 'string', description: 'Canonical profile URL.' },
    description: { type: 'string', description: 'Profile bio.' },
    location: { type: 'string' },
    followers: { type: 'integer' },
    following: { type: 'integer' },
    statuses: { type: 'integer', description: 'Lifetime post count.' },
    joined: { type: 'string', description: 'Account creation date.' },
    protected: { type: 'boolean', description: 'True when the account is private; x.md cannot read its posts.' },
    avatar_url: { type: 'string' },
  },
}

const POST_DEF = {
  type: 'object',
  description: 'A public X post. Fields are omitted when the upstream source does not supply them.',
  properties: {
    id: { type: 'string' },
    url: { type: 'string', description: 'Canonical status URL on x.com.' },
    text: { type: 'string' },
    created_at: { type: 'string' },
    lang: { type: 'string' },
    author: { $ref: '#/$defs/author' },
    quote: { $ref: '#/$defs/post' },
    replies: { type: 'integer' },
    retweets: { type: 'integer' },
    likes: { type: 'integer' },
    quotes: { type: 'integer' },
    views: { type: ['integer', 'null'] },
    context: {
      type: 'string',
      enum: ['parent', 'post', 'thread', 'reply'],
      description: 'How this post relates to the status that was requested.',
    },
  },
}

// FxTweet and FxAuthor carry more fields than these defs enumerate (media, poll,
// article, verification, ...), so the defs stay open on purpose: closing them
// would make every real response fail validation in a strict client.
const OUTPUT_DEFS = { post: POST_DEF, author: AUTHOR_DEF }

const SOURCE_ENUM = { type: 'string', enum: ['fxtwitter', 'xsearch', 'firecrawl'], description: 'Which upstream source served the result.' }
const CACHE_ENUM = { type: 'string', enum: ['hit', 'miss', 'bypass'], description: 'Whether the response came from the shared cache.' }

const BROWSE_COMMON_OUTPUT = {
  markdown: { type: 'string', description: 'Rendered Markdown, the same body the HTTP route returns.' },
  page: { type: 'integer' },
  limit: { type: 'integer' },
  next_cursor: { type: 'string', description: 'Pass back as cursor to fetch the next page. Absent on the last page.' },
  source: SOURCE_ENUM,
  cache: CACHE_ENUM,
}

function connectionTool(name: string, resource: 'followers' | 'following', title: string, description: string): McpTool {
  return {
    name,
    title,
    description,
    inputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['handle'],
      properties: { handle: HANDLE_PROPERTY, ...PAGING_PROPERTIES },
    },
    outputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['resource', 'handle', 'users', 'markdown', 'page', 'limit', 'source', 'cache'],
      properties: {
        resource: { type: 'string', const: resource },
        handle: { type: 'string' },
        users: { type: 'array', items: { $ref: '#/$defs/author' }, description: 'One page of connected accounts.' },
        ...BROWSE_COMMON_OUTPUT,
      },
      $defs: OUTPUT_DEFS,
    },
    annotations: { title, ...READ_ONLY },
  }
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'x_md_get_post',
    title: 'Read an X post or thread',
    description: 'Read one public X (formerly Twitter) post together with its thread and conversation context, as Markdown plus structured post objects. Accepts a full status permalink, or a handle plus a numeric status id. Use it whenever you are handed an x.com or twitter.com status link and need the text, author, media, engagement metrics, quoted post, or replies. Read-only and unauthenticated: it never posts, replies, likes, follows, or reads protected accounts.',
    inputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      anyOf: [{ required: ['url'] }, { required: ['handle', 'id'] }],
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          maxLength: 2048,
          description: 'Full public status permalink, for example https://x.com/pcstyle53/status/1234567890123456789. Supply this, or else both handle and id.',
        },
        handle: HANDLE_PROPERTY,
        id: {
          type: 'string',
          pattern: '^[0-9]{1,25}$',
          description: 'Numeric status id. Use together with handle when you do not have a full URL.',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'obsidian', 'json'],
          default: 'markdown',
          description: 'markdown is compact prose; obsidian adds YAML frontmatter and wikilinks; json renders the raw post objects.',
        },
        thread: {
          type: 'string',
          enum: ['off', 'full', 'conversation'],
          default: 'full',
          description: 'off returns only the requested post; full and conversation return the whole thread with its context.',
        },
        max_posts: {
          type: 'integer',
          minimum: 2,
          maximum: 100,
          description: 'Cap how many posts a thread returns. Ignored when thread is off.',
        },
        context: {
          type: 'string',
          enum: ['full', 'thread'],
          default: 'full',
          description: 'full includes parent posts and replies; thread limits the output to the author’s own chain.',
        },
        replies: {
          type: 'string',
          enum: ['top', 'recent', 'off'],
          default: 'top',
          description: 'Order replies by engagement or by recency, or omit them entirely.',
        },
        userinfo: {
          type: 'string',
          enum: ['off', 'author', 'all'],
          default: 'off',
          description: 'Attach profile details for nobody, for the author only, or for every participant.',
        },
        full: {
          type: 'boolean',
          default: false,
          description: 'Return the verbose rendering with full metrics and media detail instead of the compact one.',
        },
      },
    },
    outputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['url', 'format', 'markdown', 'post_count', 'compact', 'source', 'cache', 'warnings', 'posts'],
      properties: {
        url: { type: 'string', description: 'Canonical https://x.com status URL that was read.' },
        format: { type: 'string', enum: ['markdown', 'obsidian', 'json'] },
        markdown: { type: 'string', description: 'Rendered post or thread body.' },
        post_count: { type: 'integer', minimum: 0, description: 'How many posts the body covers.' },
        compact: { type: 'boolean', description: 'False when full was requested.' },
        source: { type: 'string', enum: ['fxtwitter', 'syndication', 'contextdev', 'firecrawl'] },
        cache: CACHE_ENUM,
        warnings: { type: 'array', items: { type: 'string' }, description: 'Non-fatal notes, such as a degraded upstream source.' },
        posts: { type: 'array', items: { $ref: '#/$defs/post' } },
      },
      $defs: OUTPUT_DEFS,
    },
    annotations: { title: 'Read an X post or thread', ...READ_ONLY },
  },
  {
    name: 'x_md_get_profile',
    title: 'Read an X profile and its latest posts',
    description: 'Read a public X profile — display name, bio, location, follower and following counts, join date, verification — together with that account’s latest original posts, with reposts and replies filtered out. Use it to find out who an account is, what it posts about, or what it has said recently. Read-only and unauthenticated; protected accounts return an error instead of partial data.',
    inputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['handle'],
      properties: { handle: HANDLE_PROPERTY, ...PAGING_PROPERTIES },
    },
    outputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['resource', 'handle', 'markdown', 'page', 'limit', 'source', 'cache'],
      properties: {
        resource: { type: 'string', const: 'profile' },
        handle: { type: 'string' },
        profile: { $ref: '#/$defs/author' },
        posts: { type: 'array', items: { $ref: '#/$defs/post' }, description: 'One page of the account’s original posts.' },
        degraded: { type: 'boolean', description: 'True when a web-index fallback served the result instead of live X data.' },
        ...BROWSE_COMMON_OUTPUT,
      },
      $defs: OUTPUT_DEFS,
    },
    annotations: { title: 'Read an X profile and its latest posts', ...READ_ONLY },
  },
  {
    name: 'x_md_search_posts',
    title: 'Search public X posts and accounts',
    description: 'Search public X posts or accounts by keyword, phrase, hashtag, or X advanced-search operator such as from:, to:, since:, until:, and filter:. Use it to find current public discussion on a topic, or to locate an account by name. Returns Markdown plus structured results. Read-only and unauthenticated; live search is rate limited per caller, and the photos, videos, and users feeds need the deployment to have X sessions configured.',
    inputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['q'],
      properties: {
        q: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Search query. Supports X advanced-search operators, for example `from:pcstyle53 filter:media`.',
        },
        feed: {
          type: 'string',
          enum: ['latest', 'top', 'photos', 'videos', 'users', 'media'],
          default: 'latest',
          description: 'latest and top return posts; users returns accounts; photos and videos return media posts; media is an alias for photos.',
        },
        ...PAGING_PROPERTIES,
      },
    },
    outputSchema: {
      $schema: DRAFT,
      type: 'object',
      additionalProperties: false,
      required: ['resource', 'query', 'feed', 'markdown', 'page', 'limit', 'source', 'cache'],
      properties: {
        resource: { type: 'string', const: 'search' },
        query: { type: 'string' },
        feed: { type: 'string' },
        posts: { type: 'array', items: { $ref: '#/$defs/post' }, description: 'Matching posts. Absent when feed is users.' },
        users: { type: 'array', items: { $ref: '#/$defs/author' }, description: 'Matching accounts. Present only when feed is users.' },
        degraded: { type: 'boolean', description: 'True when results came from a web index rather than live X: ordering and coverage differ and metrics are absent.' },
        ...BROWSE_COMMON_OUTPUT,
      },
      $defs: OUTPUT_DEFS,
    },
    annotations: { title: 'Search public X posts and accounts', ...READ_ONLY },
  },
  connectionTool(
    'x_md_get_followers',
    'followers',
    'List an X account’s followers',
    'Page through the public followers of an X account, returning each follower’s handle, display name, bio, and counts. Use it to size or sample an audience. Read-only and unauthenticated; protected accounts return an error instead of partial data.',
  ),
  connectionTool(
    'x_md_get_following',
    'following',
    'List the accounts an X account follows',
    'Page through the accounts a public X account follows, returning each one’s handle, display name, bio, and counts. Use it to map who an account pays attention to. Read-only and unauthenticated; protected accounts return an error instead of partial data.',
  ),
]

export const MCP_RESOURCES: McpResource[] = [
  {
    uri: `${MCP_SITE}/llms.txt`,
    name: 'x-md-llms-txt',
    title: 'x.md llms.txt',
    description: 'Route map, limits, and scope for the x.md HTTP API, in the llms.txt format.',
    mimeType: 'text/plain',
  },
  {
    uri: `${MCP_SITE}/llms-full.txt`,
    name: 'x-md-llms-full-txt',
    title: 'x.md full documentation',
    description: 'The whole x.md documentation site as one plain-text document.',
    mimeType: 'text/plain',
  },
  {
    uri: `${MCP_SITE}/openapi.json`,
    name: 'x-md-openapi',
    title: 'x.md OpenAPI description',
    description: 'OpenAPI description of the x.md REST routes, for callers that prefer HTTP over MCP.',
    mimeType: 'application/json',
  },
  {
    uri: `${MCP_SITE}/index.md`,
    name: 'x-md-overview',
    title: 'x.md overview',
    description: 'The x.md homepage as Markdown: what the service does, when to use it, and when not to.',
    mimeType: 'text/markdown',
  },
  {
    uri: `${MCP_SITE}/mcp/server-card`,
    name: 'x-md-server-card',
    title: 'x.md MCP server card',
    description: 'Connection metadata for this MCP server: name, version, transport, and endpoint.',
    mimeType: 'application/mcp-server-card+json',
  },
]

/**
 * Pick the revision a legacy `initialize` gets back. Only handshake-era versions
 * are eligible: a client that asks for 2026-07-28 here is confused, because that
 * revision removed `initialize` entirely, so it is answered with the newest
 * revision that actually has one.
 */
export function negotiateProtocol(requested: unknown): string {
  return typeof requested === 'string' && MCP_LEGACY_PROTOCOLS.includes(requested)
    ? requested
    : MCP_LATEST_LEGACY_PROTOCOL
}

/** The `_meta` key namespace the modern era reserves for protocol fields. */
const META = 'io.modelcontextprotocol/'

/** The protocol version a modern request declares in `params._meta`, if any. */
export function requestedProtocol(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined
  const meta = (params as { _meta?: unknown })._meta
  if (typeof meta !== 'object' || meta === null) return undefined
  const version = (meta as Record<string, unknown>)[`${META}protocolVersion`]
  return typeof version === 'string' ? version : undefined
}

/** True for 2026-07-28 and later: stateless, per-request metadata, typed results. */
export function isModernProtocol(version: string | undefined): boolean {
  return version === MCP_MODERN_PROTOCOL
}

/**
 * How long a client may treat each cacheable result as fresh. The tool and
 * resource lists are compiled into the bundle and only change on deploy; a
 * resource body is fetched live, so it gets a short window instead.
 */
const CACHE_TTL_MS: Readonly<Record<string, number>> = {
  'server/discover': 3_600_000,
  'tools/list': 3_600_000,
  'resources/list': 3_600_000,
  'resources/templates/list': 3_600_000,
  'resources/read': 300_000,
}

/**
 * Stamp the fields 2026-07-28 requires on a result: `resultType` on every one,
 * the server's identity in `_meta`, and caching hints on the operations the
 * caching section lists. Legacy results are returned untouched so each era sees
 * exactly the shape its own revision defines.
 */
export function finalizeResult(outcome: DispatchOutcome, method: string, modern: boolean): DispatchOutcome {
  if (!modern || !outcome || !('result' in outcome)) return outcome
  const result = outcome.result
  if (typeof result !== 'object' || result === null) return outcome

  const existingMeta = (result as { _meta?: unknown })._meta
  const meta = typeof existingMeta === 'object' && existingMeta !== null ? { ...(existingMeta as object) } : {}
  const stamped: Record<string, unknown> = {
    ...(result as object),
    resultType: 'complete',
    _meta: {
      ...meta,
      [`${META}serverInfo`]: { name: MCP_SERVER_NAME, title: MCP_SERVER_TITLE, version: MCP_SERVER_VERSION },
    },
  }

  const ttlMs = CACHE_TTL_MS[method]
  if (ttlMs !== undefined) {
    stamped.ttlMs = ttlMs
    // Nothing here varies by caller or credential, so a shared cache may hold it.
    stamped.cacheScope = 'public'
  }
  return { result: stamped }
}

/**
 * Decode the Base64 sentinel the modern transport allows on `Mcp-Name`.
 *
 * A tool name or resource URI that is not plain visible ASCII travels as
 * `=?base64?<utf-8 base64>?=`, and a plain value that happens to look like the
 * sentinel is encoded too. Servers MUST decode before comparing to the body.
 */
export function decodeHeaderValue(raw: string): string {
  const sentinel = /^=\?base64\?(.*)\?=$/.exec(raw)
  if (!sentinel) return raw
  try {
    return Buffer.from(sentinel[1] ?? '', 'base64').toString('utf8')
  } catch {
    return raw
  }
}

/** The methods whose `Mcp-Name` mirrors a body field, and which field that is. */
const NAMED_METHODS: Readonly<Record<string, 'name' | 'uri'>> = {
  'tools/call': 'name',
  'resources/read': 'uri',
  'prompts/get': 'name',
}

export interface ModernHeaders {
  protocolVersion?: string
  method?: string
  name?: string
}

/**
 * The header/body checks 2026-07-28 requires, as a pure function.
 *
 * `Mcp-Method` and `Mcp-Name` exist so a gateway can route and filter without
 * parsing the JSON-RPC body. That only holds if the server refuses to act on a
 * request where the two disagree — otherwise a proxy allows one method while
 * the server executes another. Returns the `-32020` error, or null when valid.
 */
export function validateModernHeaders(headers: ModernHeaders, message: JsonRpcMessage): JsonRpcError | null {
  const mismatch = (detail: string): JsonRpcError => ({ code: MCP_HEADER_MISMATCH, message: `Header mismatch: ${detail}` })
  const method = typeof message.method === 'string' ? message.method : ''

  if (!headers.protocolVersion) return mismatch('the MCP-Protocol-Version header is required.')
  if (!headers.method) return mismatch('the Mcp-Method header is required on every request.')
  if (headers.method !== method) {
    return mismatch(`Mcp-Method header value '${headers.method}' does not match body value '${method}'.`)
  }

  const source = NAMED_METHODS[method]
  if (!source) return null

  const params = typeof message.params === 'object' && message.params !== null ? (message.params as Record<string, unknown>) : {}
  const bodyValue = params[source]
  if (typeof bodyValue !== 'string') return null // The method's own params validation reports this.
  if (!headers.name) return mismatch(`the Mcp-Name header is required on ${method} requests.`)
  const headerValue = decodeHeaderValue(headers.name)
  if (headerValue !== bodyValue) {
    return mismatch(`Mcp-Name header value '${headerValue}' does not match body value '${bodyValue}'.`)
  }
  return null
}

/** The `server/discover` payload: what we speak, what we can do, and who we are. */
export function serverDiscover(): Record<string, unknown> {
  return {
    supportedVersions: [...MCP_SUPPORTED_PROTOCOLS],
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    instructions: MCP_INSTRUCTIONS,
  }
}

/** The only branded mark served from the public origin; SVG so it scales in any registry UI. */
const ICONS = [{ src: `${MCP_SITE}/logo.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }]

/**
 * The well-known server card. `serverUrl` and `tools` duplicate what `remotes`
 * and tools/list already say, because agents that read the card before opening
 * a transport look for those flatter fields.
 */
export function serverCard(): Record<string, unknown> {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    name: MCP_SERVER_NAME,
    title: MCP_SERVER_TITLE,
    description: MCP_SERVER_DESCRIPTION,
    version: MCP_SERVER_VERSION,
    websiteUrl: `${MCP_SITE}/`,
    documentationUrl: MCP_DOCS_URL,
    icons: ICONS,
    repository: { source: 'github', url: 'https://github.com/pc-style/x-md' },
    serverUrl: MCP_ENDPOINT,
    transport: 'streamable-http',
    authentication: 'none',
    remotes: [
      {
        type: 'streamable-http',
        url: MCP_ENDPOINT,
        supportedProtocolVersions: MCP_SUPPORTED_PROTOCOLS,
      },
    ],
    capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
    tools: MCP_TOOLS.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description })),
    resources: MCP_RESOURCES.map((resource) => ({ uri: resource.uri, name: resource.name, mimeType: resource.mimeType })),
  }
}

/** The registry document at /server.json, valid against the MCP registry ServerDetail schema. */
export function registryManifest(): Record<string, unknown> {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: MCP_SERVER_NAME,
    title: MCP_SERVER_TITLE,
    description: MCP_SERVER_DESCRIPTION,
    version: MCP_SERVER_VERSION,
    websiteUrl: `${MCP_SITE}/`,
    icons: ICONS,
    repository: { source: 'github', url: 'https://github.com/pc-style/x-md' },
    remotes: [{ type: 'streamable-http', url: MCP_ENDPOINT }],
  }
}

function validateProperty(key: string, schema: Record<string, unknown>, value: unknown): string | undefined {
  const type = schema.type
  if (type === 'string') {
    if (typeof value !== 'string') return `\`${key}\` must be a string`
    const options = schema.enum as string[] | undefined
    if (options && !options.includes(value)) return `\`${key}\` must be one of: ${options.join(', ')}`
    const pattern = schema.pattern as string | undefined
    if (pattern && !new RegExp(pattern).test(value)) return `\`${key}\` must match ${pattern}`
    const minLength = schema.minLength as number | undefined
    if (minLength !== undefined && value.length < minLength) return `\`${key}\` must be at least ${minLength} characters`
    const maxLength = schema.maxLength as number | undefined
    if (maxLength !== undefined && value.length > maxLength) return `\`${key}\` must be at most ${maxLength} characters`
    return undefined
  }
  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) return `\`${key}\` must be an integer`
    const minimum = schema.minimum as number | undefined
    if (minimum !== undefined && value < minimum) return `\`${key}\` must be >= ${minimum}`
    const maximum = schema.maximum as number | undefined
    if (maximum !== undefined && value > maximum) return `\`${key}\` must be <= ${maximum}`
    return undefined
  }
  if (type === 'boolean' && typeof value !== 'boolean') return `\`${key}\` must be a boolean`
  return undefined
}

/** Returns a human-readable reason the arguments do not satisfy the tool's inputSchema. */
export function validateArguments(tool: McpTool, raw: unknown): string | undefined {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    return '`arguments` must be a JSON object'
  }
  const args = (raw ?? {}) as Record<string, unknown>
  const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>
  for (const key of (tool.inputSchema.required as string[] | undefined) ?? []) {
    if (args[key] === undefined) return `missing required property \`${key}\``
  }
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue
    const schema = properties[key]
    if (!schema) return `unknown property \`${key}\`; allowed: ${Object.keys(properties).join(', ')}`
    const problem = validateProperty(key, schema, value)
    if (problem) return problem
  }
  const alternatives = tool.inputSchema.anyOf as Array<{ required: string[] }> | undefined
  if (alternatives && !alternatives.some((option) => option.required.every((key) => args[key] !== undefined))) {
    return `supply ${alternatives.map((option) => option.required.map((key) => `\`${key}\``).join(' and ')).join(', or ')}`
  }
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function browseStructured(result: BrowseResult): Record<string, unknown> {
  const structured: Record<string, unknown> = {
    resource: result.resource,
    markdown: result.markdown,
    page: result.page,
    limit: result.limit,
    source: result.source,
    cache: result.cache,
  }
  if (result.handle !== undefined) structured.handle = result.handle
  if (result.query !== undefined) structured.query = result.query
  if (result.feed !== undefined) structured.feed = result.feed
  if (result.profile !== undefined) structured.profile = result.profile
  if (result.posts !== undefined) structured.posts = result.posts
  if (result.users !== undefined) structured.users = result.users
  if (result.nextCursor !== undefined) structured.next_cursor = result.nextCursor
  if (result.degraded !== undefined) structured.degraded = result.degraded
  return structured
}

type ToolRunner = (args: Record<string, unknown>, ctx: McpContext) => Promise<{ text: string; structured: Record<string, unknown> }>

async function runBrowse(
  resource: 'profile' | 'search' | 'followers' | 'following',
  args: Record<string, unknown>,
  ctx: McpContext,
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const result = await browse({
    resource,
    handle: text(args.handle)?.replace(/^@/, '') ?? null,
    q: text(args.q) ?? null,
    feed: text(args.feed) ?? null,
    cursor: text(args.cursor) ?? null,
    page: typeof args.page === 'number' ? args.page : null,
    limit: typeof args.limit === 'number' ? args.limit : null,
    full: args.full === true,
    ip: ctx.ip ?? null,
    caller: ctx.caller,
  })
  return { text: result.markdown, structured: browseStructured(result) }
}

const TOOL_RUNNERS: Record<string, ToolRunner> = {
  async x_md_get_post(args) {
    const thread = text(args.thread) ?? 'full'
    const result = await convertTweet({
      url: text(args.url) ?? null,
      handle: text(args.handle) ?? null,
      id: text(args.id) ?? null,
      format: text(args.format) ?? null,
      // `max_posts` is the typed spelling of the thread cap the HTTP route takes as `thread=<n>`.
      thread: thread !== 'off' && typeof args.max_posts === 'number' ? String(args.max_posts) : thread,
      context: text(args.context) ?? null,
      replies: text(args.replies) ?? null,
      userinfo: text(args.userinfo) ?? null,
      full: args.full === true,
    })
    return {
      text: result.body,
      structured: {
        url: result.canonicalUrl,
        format: result.format,
        markdown: result.body,
        post_count: result.postCount,
        compact: result.compact,
        source: result.source,
        cache: result.cache,
        warnings: result.warnings,
        posts: result.posts,
      },
    }
  },
  x_md_get_profile: (args, ctx) => runBrowse('profile', args, ctx),
  x_md_search_posts: (args, ctx) => runBrowse('search', args, ctx),
  x_md_get_followers: (args, ctx) => runBrowse('followers', args, ctx),
  x_md_get_following: (args, ctx) => runBrowse('following', args, ctx),
}

async function callTool(params: unknown, ctx: McpContext): Promise<DispatchOutcome> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { error: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid params: tools/call requires an object with a `name`.' } }
  }
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown }
  if (typeof name !== 'string' || !name) {
    return { error: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid params: `name` must be the string name of a tool.', data: { available: MCP_TOOLS.map((tool) => tool.name) } } }
  }
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name)
  if (!tool) {
    return { error: { code: JSONRPC_INVALID_PARAMS, message: `Tool ${name} not found`, data: { available: MCP_TOOLS.map((candidate) => candidate.name) } } }
  }
  const invalid = validateArguments(tool, args)
  if (invalid) {
    return { error: { code: JSONRPC_INVALID_PARAMS, message: `Invalid arguments for tool ${name}: ${invalid}`, data: { schema: tool.inputSchema } } }
  }

  try {
    const outcome = await TOOL_RUNNERS[tool.name]!((args ?? {}) as Record<string, unknown>, ctx)
    return { result: { content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured, isError: false } }
  } catch (error) {
    // Upstream failures belong in the result so the model can read and react to
    // them; only protocol mistakes come back as JSON-RPC errors.
    if (error instanceof ConvertError) {
      const retry = error.retryAfter ? `, retry after ${error.retryAfter}s` : ''
      return {
        result: {
          content: [{ type: 'text', text: `${error.message} (HTTP ${error.status}, code ${error.code ?? 'unknown'}${retry})` }],
          isError: true,
        },
      }
    }
    console.error(error)
    return { result: { content: [{ type: 'text', text: `Tool ${name} failed against an upstream source. Retry in a moment.` }], isError: true } }
  }
}

async function readResource(params: unknown): Promise<DispatchOutcome> {
  const uri = typeof params === 'object' && params !== null ? (params as { uri?: unknown }).uri : undefined
  if (typeof uri !== 'string' || !uri) {
    return { error: { code: JSONRPC_INVALID_PARAMS, message: 'Invalid params: `uri` must be the string uri of a resource.', data: { available: MCP_RESOURCES.map((resource) => resource.uri) } } }
  }
  const resource = MCP_RESOURCES.find((candidate) => candidate.uri === uri)
  if (!resource) {
    return { error: { code: MCP_RESOURCE_NOT_FOUND, message: `Resource ${uri} not found`, data: { available: MCP_RESOURCES.map((candidate) => candidate.uri) } } }
  }
  // The server card is generated here, so serve it without a round trip.
  if (resource.uri === `${MCP_SITE}/mcp/server-card`) {
    return { result: { contents: [{ uri, name: resource.name, title: resource.title, mimeType: resource.mimeType, text: JSON.stringify(serverCard(), null, 2) }] } }
  }
  try {
    // `resource.uri`, not `uri`: the caller's string only selected the entry,
    // so the URL fetched is always one of the constants in MCP_RESOURCES.
    const response = await fetch(resource.uri, { headers: { Accept: resource.mimeType }, signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`upstream ${response.status}`)
    const body = await response.text()
    return { result: { contents: [{ uri, name: resource.name, title: resource.title, mimeType: resource.mimeType, text: body }] } }
  } catch {
    return { error: { code: JSONRPC_INTERNAL_ERROR, message: `Resource ${uri} could not be read right now. Fetch it over HTTPS instead.` } }
  }
}

/**
 * Methods that exist in only one era. 2026-07-28 removed the `initialize`
 * handshake and `ping`; `server/discover` replaced them and does not exist
 * before it. Answering a method from the wrong era would tell a client the
 * server speaks a revision it does not.
 */
const ERA_ONLY: Readonly<Record<string, 'modern' | 'legacy'>> = {
  'server/discover': 'modern',
  initialize: 'legacy',
  ping: 'legacy',
}

export async function dispatch(message: JsonRpcMessage, ctx: McpContext = {}): Promise<DispatchOutcome> {
  const method = typeof message.method === 'string' ? message.method : ''

  // Notifications carry no id and are answered with 202 and an empty body.
  if (method.startsWith('notifications/')) return null

  // Default to legacy so a direct dispatch() call keeps the handshake surface.
  const era = ctx.era ?? 'legacy'
  const only = ERA_ONLY[method]
  if (only && only !== era) {
    return {
      error: {
        code: JSONRPC_METHOD_NOT_FOUND,
        message: 'Method not found',
        data: {
          method,
          reason: only === 'modern'
            ? `${method} exists only in protocol revision ${MCP_MODERN_PROTOCOL} and later.`
            : `${method} was removed in protocol revision ${MCP_MODERN_PROTOCOL}.`,
          era,
        },
      },
    }
  }

  switch (method) {
    case 'initialize': {
      const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as { protocolVersion?: unknown }
      return {
        result: {
          protocolVersion: negotiateProtocol(params.protocolVersion),
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: {
            name: MCP_SERVER_NAME,
            title: MCP_SERVER_TITLE,
            version: MCP_SERVER_VERSION,
            websiteUrl: `${MCP_SITE}/`,
          },
          instructions: MCP_INSTRUCTIONS,
        },
      }
    }
    case 'server/discover':
      return { result: serverDiscover() }
    case 'ping':
      return { result: {} }
    case 'tools/list':
      return { result: { tools: MCP_TOOLS } }
    case 'tools/call':
      return callTool(message.params, ctx)
    case 'resources/list':
      return { result: { resources: MCP_RESOURCES } }
    case 'resources/templates/list':
      return { result: { resourceTemplates: [] } }
    case 'resources/read':
      return readResource(message.params)
    default:
      return { error: { code: JSONRPC_METHOD_NOT_FOUND, message: 'Method not found', data: { method, supported: ['server/discover', 'initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read'] } } }
  }
}
