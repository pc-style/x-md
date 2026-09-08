import { readFileSync } from 'node:fs'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./browse.js', () => ({ browse: vi.fn() }))
vi.mock('./converter.js', () => ({ convertTweet: vi.fn() }))

import handler from '../api/mcp.js'
import { browse } from './browse.js'
import { convertTweet } from './converter.js'
import { ConvertError } from './errors.js'
import {
  dispatch,
  negotiateProtocol,
  registryManifest,
  serverCard,
  MCP_LATEST_LEGACY_PROTOCOL,
  MCP_RESOURCE_NOT_FOUND,
  finalizeResult,
  isModernProtocol,
  requestedProtocol,
  MCP_MODERN_PROTOCOL,
  MCP_RESOURCES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
} from './mcp.js'

const browseMock = vi.mocked(browse)
const convertMock = vi.mocked(convertTweet)

function ok(outcome: Awaited<ReturnType<typeof dispatch>>): Record<string, unknown> {
  if (!outcome || !('result' in outcome)) throw new Error(`expected a result, got ${JSON.stringify(outcome)}`)
  return outcome.result as Record<string, unknown>
}

function failure(outcome: Awaited<ReturnType<typeof dispatch>>): { code: number; message: string } {
  if (!outcome || !('error' in outcome)) throw new Error(`expected an error, got ${JSON.stringify(outcome)}`)
  return outcome.error
}

const profileResult = {
  resource: 'profile' as const,
  handle: 'pcstyle53',
  profile: { screen_name: 'pcstyle53', name: 'pc' },
  posts: [{ id: '1', text: 'hello' }],
  page: 1,
  limit: 20,
  nextCursor: 'fxtwitter:abc',
  source: 'fxtwitter' as const,
  markdown: '# pc (@pcstyle53)',
  cache: 'miss' as const,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('protocol negotiation', () => {
  test('echoes a revision we speak and downgrades everything else', () => {
    expect(negotiateProtocol('2025-06-18')).toBe('2025-06-18')
    expect(negotiateProtocol('2025-03-26')).toBe('2025-03-26')
    // 2026-07-28 removed initialize, so the handshake never answers with it.
    expect(negotiateProtocol('2026-07-28')).toBe(MCP_LATEST_LEGACY_PROTOCOL)
    expect(negotiateProtocol(undefined)).toBe(MCP_LATEST_LEGACY_PROTOCOL)
    expect(negotiateProtocol(42)).toBe(MCP_LATEST_LEGACY_PROTOCOL)
  })

  test('initialize identifies the server and echoes the requested revision', async () => {
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }))
    expect(result.protocolVersion).toBe('2025-06-18')
    expect(result.serverInfo).toMatchObject({ name: MCP_SERVER_NAME, title: 'x.md', version: MCP_SERVER_VERSION })
    expect(result.capabilities).toEqual({ tools: { listChanged: false }, resources: { listChanged: false } })
    expect(String(result.instructions).length).toBeGreaterThan(200)
  })

  test('initialize without params still answers with the newest revision', async () => {
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize' }))
    expect(result.protocolVersion).toBe(MCP_LATEST_LEGACY_PROTOCOL)
  })

  test('notifications get no reply and ping gets an empty one', async () => {
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })).toBeNull()
    expect(ok(await dispatch({ jsonrpc: '2.0', id: 2, method: 'ping' }))).toEqual({})
  })

  test('an unknown method is a method-not-found error', async () => {
    expect(failure(await dispatch({ jsonrpc: '2.0', id: 3, method: 'prompts/list' })).code).toBe(-32601)
    expect(failure(await dispatch({ jsonrpc: '2.0', id: 3, method: '' })).code).toBe(-32601)
  })
})

describe('tools/list', () => {
  test('every tool is named, described, typed, and annotated read-only', async () => {
    const tools = ok(await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).tools as typeof MCP_TOOLS
    expect(tools).toHaveLength(5)
    expect(tools.map((tool) => tool.name)).toEqual([
      'x_md_get_post',
      'x_md_get_profile',
      'x_md_search_posts',
      'x_md_get_followers',
      'x_md_get_following',
    ])
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)

    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/)
      expect(tool.name.length).toBeGreaterThanOrEqual(4)
      expect(tool.title.length).toBeGreaterThan(0)
      expect(tool.description.length).toBeGreaterThanOrEqual(20)
      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      })

      expect(tool.inputSchema.type).toBe('object')
      expect(tool.inputSchema.additionalProperties).toBe(false)
      const properties = tool.inputSchema.properties as Record<string, Record<string, unknown>>
      expect(Object.keys(properties).length).toBeGreaterThan(0)
      for (const [key, schema] of Object.entries(properties)) {
        expect(typeof schema.type, `${tool.name}.${key} type`).toBe('string')
        expect(String(schema.description ?? ''), `${tool.name}.${key} description`).not.toBe('')
      }
      expect(tool.outputSchema.type).toBe('object')
      expect((tool.outputSchema.required as string[]).length).toBeGreaterThan(0)
    }
  })

  test('the four tools with a fixed argument declare it required', async () => {
    const tools = ok(await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).tools as typeof MCP_TOOLS
    const required = Object.fromEntries(tools.map((tool) => [tool.name, tool.inputSchema.required]))
    expect(required.x_md_get_profile).toEqual(['handle'])
    expect(required.x_md_search_posts).toEqual(['q'])
    expect(required.x_md_get_followers).toEqual(['handle'])
    expect(required.x_md_get_following).toEqual(['handle'])
    // get_post takes a url OR a handle plus an id, so the choice is an anyOf.
    expect(tools[0]!.inputSchema.anyOf).toEqual([{ required: ['url'] }, { required: ['handle', 'id'] }])
  })

  test('every schema survives a JSON round trip', () => {
    for (const tool of MCP_TOOLS) {
      expect(JSON.parse(JSON.stringify(tool))).toEqual(tool)
    }
  })
})

describe('tools/call', () => {
  test('a profile call returns markdown, structured content, and no error flag', async () => {
    browseMock.mockResolvedValue(profileResult)
    const result = ok(await dispatch(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'x_md_get_profile', arguments: { handle: '@pcstyle53', limit: 3 } } },
      { ip: '203.0.113.7' },
    ))
    expect(browseMock).toHaveBeenCalledWith(expect.objectContaining({ resource: 'profile', handle: 'pcstyle53', limit: 3, ip: '203.0.113.7' }))
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: '# pc (@pcstyle53)' }])
    const structured = result.structuredContent as Record<string, unknown>
    expect(structured.next_cursor).toBe('fxtwitter:abc')
    const tool = MCP_TOOLS.find((candidate) => candidate.name === 'x_md_get_profile')!
    for (const key of tool.outputSchema.required as string[]) {
      expect(structured[key], `structuredContent.${key}`).toBeDefined()
    }
    const allowed = Object.keys(tool.outputSchema.properties as Record<string, unknown>)
    expect(Object.keys(structured).filter((key) => !allowed.includes(key))).toEqual([])
  })

  test('a post call maps max_posts onto the thread cap the converter takes', async () => {
    convertMock.mockResolvedValue({
      body: '# post',
      warnings: [],
      canonicalUrl: 'https://x.com/pcstyle53/status/1',
      format: 'markdown',
      postCount: 1,
      source: 'fxtwitter',
      cache: 'miss',
      posts: [],
      compact: true,
    })
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'x_md_get_post', arguments: { url: 'https://x.com/pcstyle53/status/1', max_posts: 12 } } }))
    expect(convertMock).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://x.com/pcstyle53/status/1', thread: '12' }))
    expect((result.structuredContent as Record<string, unknown>).post_count).toBe(1)
  })

  test('malformed params are invalid-params errors, not crashes', async () => {
    expect(failure(await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call' })).code).toBe(-32602)
    expect(failure(await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { arguments: {} } })).code).toBe(-32602)
    expect(failure(await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } }))).toMatchObject({ code: -32602, message: 'Tool nope not found' })
    expect(failure(await dispatch({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x_md_get_profile', arguments: [] } })).code).toBe(-32602)
  })

  test('arguments that miss the schema explain how to fix themselves', async () => {
    const missing = failure(await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_md_get_profile', arguments: {} } }))
    expect(missing.code).toBe(-32602)
    expect(missing.message).toContain('missing required property `handle`')

    const badEnum = failure(await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_md_search_posts', arguments: { q: 'vercel', feed: 'reels' } } }))
    expect(badEnum.message).toContain('must be one of: latest, top, photos, videos, users, media')

    const badRange = failure(await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_md_get_followers', arguments: { handle: 'pcstyle53', limit: 500 } } }))
    expect(badRange.message).toContain('`limit` must be <= 20')

    const badType = failure(await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_md_get_following', arguments: { handle: 'pcstyle53', page: '2' } } }))
    expect(badType.message).toContain('`page` must be an integer')

    const unknown = failure(await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_md_get_profile', arguments: { handle: 'pcstyle53', depth: 3 } } }))
    expect(unknown.message).toContain('unknown property `depth`')

    const neither = failure(await dispatch({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'x_md_get_post', arguments: { format: 'json' } } }))
    expect(neither.message).toContain('supply `url`, or `handle` and `id`')

    expect(browseMock).not.toHaveBeenCalled()
    expect(convertMock).not.toHaveBeenCalled()
  })

  test('an upstream failure is a tool result, never a transport error', async () => {
    browseMock.mockRejectedValue(new ConvertError(429, 'Search rate limit reached.', 'rate_limited', 45))
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'x_md_search_posts', arguments: { q: 'vercel' } } }))
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toBe('Search rate limit reached. (HTTP 429, code rate_limited, retry after 45s)')
    expect(result.structuredContent).toBeUndefined()
  })

  test('an unexpected throw still comes back as a readable tool result', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    browseMock.mockRejectedValue(new Error('socket hang up'))
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'x_md_get_profile', arguments: { handle: 'pcstyle53' } } }))
    expect(result.isError).toBe(true)
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('x_md_get_profile')
    logged.mockRestore()
  })
})

describe('resources', () => {
  test('resources/list returns the agent documents with types', async () => {
    const resources = ok(await dispatch({ jsonrpc: '2.0', id: 11, method: 'resources/list' })).resources as typeof MCP_RESOURCES
    expect(resources.length).toBeGreaterThanOrEqual(4)
    expect(resources.map((resource) => resource.uri)).toEqual([
      'https://x.pcstyle.dev/llms.txt',
      'https://x.pcstyle.dev/llms-full.txt',
      'https://x.pcstyle.dev/openapi.json',
      'https://x.pcstyle.dev/index.md',
      'https://x.pcstyle.dev/mcp/server-card',
    ])
    for (const resource of resources) {
      expect(resource.name).toMatch(/^[a-z0-9-]+$/)
      expect(resource.mimeType).toMatch(/\//)
      expect(resource.description.length).toBeGreaterThanOrEqual(20)
    }
    expect(ok(await dispatch({ jsonrpc: '2.0', id: 11, method: 'resources/templates/list' }))).toEqual({ resourceTemplates: [] })
  })

  test('resources/read fetches a document and labels it', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => '# x.md\n' }))
    vi.stubGlobal('fetch', fetchMock)
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'https://x.pcstyle.dev/llms.txt' } }))
    expect(fetchMock).toHaveBeenCalledWith('https://x.pcstyle.dev/llms.txt', expect.objectContaining({ headers: { Accept: 'text/plain' } }))
    expect((result.contents as Array<Record<string, unknown>>)[0]).toMatchObject({ uri: 'https://x.pcstyle.dev/llms.txt', mimeType: 'text/plain', text: '# x.md\n' })
    vi.unstubAllGlobals()
  })

  test('the server card reads without a round trip', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 13, method: 'resources/read', params: { uri: 'https://x.pcstyle.dev/mcp/server-card' } }))
    expect(fetchMock).not.toHaveBeenCalled()
    const contents = (result.contents as Array<{ text: string; mimeType: string }>)[0]!
    expect(contents.mimeType).toBe('application/mcp-server-card+json')
    expect(JSON.parse(contents.text)).toEqual(serverCard())
    vi.unstubAllGlobals()
  })

  test('an unknown or missing uri is a structured error', async () => {
    // 2026-07-28 folded resource-not-found into Invalid Params, so both are
    // -32602 and the `data` is what tells a client which one it hit.
    const missing = failure(await dispatch({ jsonrpc: '2.0', id: 14, method: 'resources/read', params: {} }))
    expect(missing.code).toBe(-32602)
    const unknown = failure(await dispatch({ jsonrpc: '2.0', id: 14, method: 'resources/read', params: { uri: 'https://x.pcstyle.dev/nope.txt' } }))
    expect(unknown.code).toBe(MCP_RESOURCE_NOT_FOUND)
    expect((unknown.data as { available?: unknown }).available).toBeDefined()
  })

  test('an unreachable document fails loudly instead of returning empty content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })))
    const error = failure(await dispatch({ jsonrpc: '2.0', id: 15, method: 'resources/read', params: { uri: 'https://x.pcstyle.dev/openapi.json' } }))
    expect(error.code).toBe(-32603)
    vi.unstubAllGlobals()
  })
})

describe('discovery documents', () => {
  test('the registry manifest matches the published ServerDetail constraints', () => {
    const manifest = registryManifest()
    expect(manifest.name).toBe(MCP_SERVER_NAME)
    expect(String(manifest.name)).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/)
    expect(String(manifest.description).length).toBeLessThanOrEqual(100)
    expect(String(manifest.title).length).toBeLessThanOrEqual(100)
    expect(manifest.remotes).toEqual([{ type: 'streamable-http', url: 'https://x.pcstyle.dev/mcp' }])
    expect(manifest.repository).toEqual({ source: 'github', url: 'https://github.com/pc-style/x-md' })
  })

  test('the static copies Vercel serves cannot drift from the generated ones', () => {
    // Vercel checks the filesystem before it applies a rewrite, so the files in
    // public/ are what agents actually fetch. Regenerate them when either
    // document changes.
    expect(JSON.parse(readFileSync('public/server.json', 'utf8'))).toEqual(registryManifest())
    expect(JSON.parse(readFileSync('public/.well-known/mcp/server-card.json', 'utf8'))).toEqual(serverCard())
  })

  test('the server card carries the branding a registry listing renders', () => {
    const card = serverCard()
    expect(card.title).toBe('x.md')
    expect(String(card.description).length).toBeGreaterThan(20)
    expect(card.icons).toEqual([{ src: 'https://x.pcstyle.dev/logo.svg', mimeType: 'image/svg+xml', sizes: ['any'] }])
    expect(card.serverUrl).toBe('https://x.pcstyle.dev/mcp')
    expect(card.transport).toBe('streamable-http')
    expect((card.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(MCP_TOOLS.map((tool) => tool.name))
    expect(JSON.parse(JSON.stringify(card))).toEqual(card)
  })
})

interface Exchange {
  req: Record<string, unknown>
  res: Record<string, unknown> & { statusCode: number; getHeader(name: string): unknown }
  body(): string
}

function exchange(method: string, options: { accept?: string; body?: unknown; query?: Record<string, string>; headers?: Record<string, string> } = {}): Exchange {
  const req = new IncomingMessage(new Socket()) as never as Record<string, unknown>
  req.method = method
  req.query = options.query ?? {}
  req.headers = { accept: options.accept ?? '*/*', ...options.headers }
  req.body = options.body
  const chunks: string[] = []
  const res = new ServerResponse(req as never) as never as Exchange['res'] & Record<string, unknown>
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = (payload?: unknown) => { if (payload !== undefined) chunks.push(String(payload)); return res }
  res.json = (payload: unknown) => { chunks.push(JSON.stringify(payload)); return res }
  res.write = (chunk: unknown) => { chunks.push(String(chunk)); return true }
  res.end = () => res
  return { req, res, body: () => chunks.join('') }
}

async function call(method: string, options?: Parameters<typeof exchange>[1]) {
  const held = exchange(method, options)
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(held.req, held.res)
  return held
}

describe('the HTTP transport', () => {
  test('GET answers with a JSON manifest rather than markdown', async () => {
    const held = await call('GET')
    expect(held.res.statusCode).toBe(200)
    expect(held.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')
    const manifest = JSON.parse(held.body())
    expect(manifest).toMatchObject({ name: MCP_SERVER_NAME, serverUrl: 'https://x.pcstyle.dev/mcp', transport: 'streamable-http' })
    expect(manifest.protocolVersions).toContain(MCP_MODERN_PROTOCOL)
    expect(manifest.tools).toHaveLength(MCP_TOOLS.length)
  })

  test('a client opening the optional SSE stream gets a parseable 405', async () => {
    const held = await call('GET', { accept: 'text/event-stream' })
    expect(held.res.statusCode).toBe(405)
    expect(held.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(held.body()).error.code).toBe(-32600)
    expect(held.res.getHeader('Allow')).toBe('POST, OPTIONS')
  })

  test('every rejected method still answers in JSON', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const held = await call(method)
      expect(held.res.statusCode, method).toBe(405)
      expect(() => JSON.parse(held.body()), method).not.toThrow()
    }
    const preflight = await call('OPTIONS')
    expect(preflight.res.statusCode).toBe(204)
    expect(preflight.res.getHeader('Allow')).toBe('GET, HEAD, OPTIONS, POST, DELETE')
    expect(preflight.res.getHeader('Access-Control-Allow-Origin')).toBe('*')
    const head = await call('HEAD')
    expect(head.res.statusCode).toBe(200)
    expect(head.body()).toBe('')
  })

  test('the server card is served as its own media type', async () => {
    const held = await call('GET', { query: { doc: 'server-card' } })
    expect(held.res.statusCode).toBe(200)
    expect(held.res.getHeader('Content-Type')).toBe('application/mcp-server-card+json; charset=utf-8')
    expect(JSON.parse(held.body())).toEqual(serverCard())
  })

  test('POST answers JSON-RPC as plain JSON or as one SSE frame', async () => {
    const json = await call('POST', { accept: 'application/json', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    expect(json.res.statusCode).toBe(200)
    expect(json.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')
    expect(json.res.getHeader('Cache-Control')).toBe('no-store')
    expect(JSON.parse(json.body()).result.tools).toHaveLength(MCP_TOOLS.length)

    const stream = await call('POST', { accept: 'application/json, text/event-stream', body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } } })
    expect(stream.res.getHeader('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(stream.res.getHeader('X-Accel-Buffering')).toBe('no')
    expect(stream.body().startsWith('event: message\ndata: ')).toBe(true)
    expect(JSON.parse(stream.body().slice('event: message\ndata: '.length)).result.protocolVersion).toBe('2025-06-18')
  })

  test('the Accept header is parsed, not substring-matched, before SSE is chosen', async () => {
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

    // q=0 is a rejection: a client that cannot read SSE must not be sent it.
    const rejected = await call('POST', { accept: 'application/json, text/event-stream;q=0', body: message })
    expect(rejected.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')
    expect(JSON.parse(rejected.body()).result.tools).toHaveLength(MCP_TOOLS.length)

    // Media types are case-insensitive (RFC 9110 8.3.1).
    const cased = await call('POST', { accept: 'Application/JSON, Text/Event-Stream', body: message })
    expect(cased.res.getHeader('Content-Type')).toBe('text/event-stream; charset=utf-8')

    // A wildcard names no stream, so a browser or curl still gets JSON.
    const wildcard = await call('POST', { accept: '*/*', body: message })
    expect(wildcard.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')

    // The same parse gates the GET that would open a standalone stream.
    const get = await call('GET', { accept: 'application/json, text/event-stream;q=0' })
    expect(get.res.statusCode).toBe(200)
    expect(get.res.getHeader('Content-Type')).toBe('application/json; charset=utf-8')
  })

  test('a notification is accepted with no body', async () => {
    const held = await call('POST', { accept: 'application/json', body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect(held.res.statusCode).toBe(202)
    expect(held.body()).toBe('')
  })

  test('unparseable and malformed messages get the right JSON-RPC codes', async () => {
    const parse = await call('POST', { accept: 'application/json', body: 'not json' })
    expect(parse.res.statusCode).toBe(400)
    expect(JSON.parse(parse.body())).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: Invalid JSON' } })

    for (const body of [[{ jsonrpc: '2.0', id: 1, method: 'ping' }], { method: 'ping' }, { jsonrpc: '1.0', method: 'ping' }]) {
      const held = await call('POST', { accept: 'application/json', body })
      expect(held.res.statusCode).toBe(400)
      expect(JSON.parse(held.body()).error.code).toBe(-32600)
    }
  })

  test('the protocol version header is validated and echoed', async () => {
    const rejected = await call('POST', { accept: 'application/json', headers: { 'mcp-protocol-version': '1999-01-01' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    expect(rejected.res.statusCode).toBe(400)
    expect(JSON.parse(rejected.body()).error.data.supported).toContain(MCP_MODERN_PROTOCOL)

    const accepted = await call('POST', { accept: 'application/json', headers: { 'mcp-protocol-version': '2025-06-18' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    expect(accepted.res.statusCode).toBe(200)
    expect(accepted.res.getHeader('MCP-Protocol-Version')).toBe('2025-06-18')
  })

  test('a session id sent by an older client is ignored, never echoed', async () => {
    const held = await call('POST', { accept: 'application/json', headers: { 'mcp-session-id': 'junk' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })
    expect(held.res.statusCode).toBe(200)
    expect(held.res.getHeader('Mcp-Session-Id')).toBeUndefined()
  })
})

describe('the 2026-07-28 stateless era', () => {
  const META = 'io.modelcontextprotocol/'
  const modernParams = { _meta: { [`${META}protocolVersion`]: MCP_MODERN_PROTOCOL } }

  test('server/discover is implemented, as the revision requires', async () => {
    const result = ok(await dispatch({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: modernParams }))
    expect(result.supportedVersions).toContain(MCP_MODERN_PROTOCOL)
    expect(result.supportedVersions).toContain(MCP_LATEST_LEGACY_PROTOCOL)
    expect(result.capabilities).toEqual({ tools: { listChanged: false }, resources: { listChanged: false } })
    expect(typeof result.instructions).toBe('string')
  })

  test('the protocol version is read from per-request _meta', () => {
    expect(requestedProtocol(modernParams)).toBe(MCP_MODERN_PROTOCOL)
    expect(requestedProtocol({ _meta: {} })).toBeUndefined()
    expect(requestedProtocol({})).toBeUndefined()
    expect(requestedProtocol(undefined)).toBeUndefined()
    expect(isModernProtocol(MCP_MODERN_PROTOCOL)).toBe(true)
    expect(isModernProtocol(MCP_LATEST_LEGACY_PROTOCOL)).toBe(false)
    expect(isModernProtocol(undefined)).toBe(false)
  })

  test('a modern result carries resultType and the server identity', async () => {
    const raw = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: modernParams })
    const result = ok(finalizeResult(raw, 'tools/list', true))
    expect(result.resultType).toBe('complete')
    expect((result._meta as Record<string, unknown>)[`${META}serverInfo`]).toMatchObject({ name: MCP_SERVER_NAME })
    expect(Array.isArray(result.tools)).toBe(true)
  })

  test('every cacheable operation carries a non-negative ttl and a scope', async () => {
    for (const method of ['server/discover', 'tools/list', 'resources/list', 'resources/templates/list']) {
      const result = ok(finalizeResult(await dispatch({ jsonrpc: '2.0', id: 3, method, params: modernParams }), method, true))
      expect(typeof result.ttlMs).toBe('number')
      expect(result.ttlMs as number).toBeGreaterThanOrEqual(0)
      expect(result.cacheScope).toBe('public')
    }
  })

  test('tools/call is not cacheable, so it gets no freshness hint', async () => {
    const result = { result: { content: [] } }
    const stamped = ok(finalizeResult(result, 'tools/call', true))
    expect(stamped.resultType).toBe('complete')
    expect(stamped.ttlMs).toBeUndefined()
    expect(stamped.cacheScope).toBeUndefined()
  })

  test('a legacy result is left exactly as its own revision defines it', async () => {
    const raw = await dispatch({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    const result = ok(finalizeResult(raw, 'tools/list', false))
    expect(result.resultType).toBeUndefined()
    expect(result.ttlMs).toBeUndefined()
    expect(result._meta).toBeUndefined()
  })

  test('an error is never stamped as a complete result', async () => {
    const failed = await dispatch({ jsonrpc: '2.0', id: 5, method: 'nope', params: modernParams })
    expect(finalizeResult(failed, 'nope', true)).toEqual(failed)
    expect(finalizeResult(null, 'notifications/x', true)).toBeNull()
  })
})
