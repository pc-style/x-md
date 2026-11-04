import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import Ajv2020 from 'ajv/dist/2020'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./history.js', async (original) => {
  const actual = await original<typeof import('./history.js')>()
  return { ...actual, importWithHistory: vi.fn() }
})

import importHandler from '../api/import.js'
import mcpHandler from '../api/mcp.js'
import { createApiKey } from './apikeys.js'
import { importWithHistory, type HistoryInput } from './history.js'
import { MCP_MODERN_PROTOCOL, MCP_TOOLS } from './mcp.js'
import { peekRateLimits, resetRateLimits } from './ratelimit.js'

const HOUR = 3_600_000
// 10:05 UTC: 55 minutes left in the hour window, 13 h 55 min in the day window.
const START = Date.UTC(2026, 10, 4, 10, 5)
const NEXT_UNTIL = '2026-11-03T12:00:00.000Z'

type Res = ServerResponse & { getHeader(name: string): unknown }

function respond(req: IncomingMessage) {
  const chunks: string[] = []
  const res = new ServerResponse(req) as never as Res & Record<string, unknown>
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = (payload?: unknown) => { if (payload !== undefined) chunks.push(String(payload)); return res }
  res.write = (chunk: unknown) => { chunks.push(String(chunk)); return true }
  res.end = () => res
  res.flushHeaders = () => {}
  return { res, body: () => chunks.join('') }
}

async function http(ip: string, query: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket())
  Object.assign(req, { method: 'GET', query: { handle: 'NASA', ...query }, headers: { accept: 'application/json', 'x-forwarded-for': ip, ...headers } })
  const { res, body } = respond(req)
  await (importHandler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res)
  return { res, json: JSON.parse(body()) }
}

const META = 'io.modelcontextprotocol/'
async function mcp(ip: string, args: Record<string, unknown>, options: { headers?: Record<string, string>; modern?: boolean; id?: number } = {}) {
  const req = new IncomingMessage(new Socket())
  const params: Record<string, unknown> = { name: 'x_md_import_posts', arguments: args }
  const headers: Record<string, string> = { accept: 'application/json', 'x-forwarded-for': ip, ...options.headers }
  if (options.modern) {
    params._meta = { [`${META}protocolVersion`]: MCP_MODERN_PROTOCOL, [`${META}clientCapabilities`]: {} }
    Object.assign(headers, { 'mcp-protocol-version': MCP_MODERN_PROTOCOL, 'mcp-method': 'tools/call', 'mcp-name': 'x_md_import_posts' })
  }
  Object.assign(req, { method: 'POST', query: {}, headers, body: { jsonrpc: '2.0', id: options.id ?? 1, method: 'tools/call', params } })
  const { res, body } = respond(req)
  await (mcpHandler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, res)
  return { res, json: JSON.parse(body()) }
}

const imports = () => vi.mocked(importWithHistory).mock.calls.length
const count = async (key: string, windowSec: number) => (await peekRateLimits([{ key, windowSec }]))[0]

beforeEach(() => {
  vi.useFakeTimers({ now: START, toFake: ['Date'] })
  resetRateLimits()
  vi.mocked(importWithHistory).mockReset().mockImplementation(async (input: HistoryInput) => {
    const posts = [
      { id: '2118041009766678695', text: 'newer', created_at: 'Wed Nov 04 18:01:42 +0000 2026', author: { screen_name: 'NASA' } },
      { id: '2117697122208555440', text: 'older', created_at: 'Tue Nov 03 19:15:13 +0000 2026', author: { screen_name: 'NASA' } },
    ]
    // A request from the top of the range is truncated and continues; a continuation reaches the end.
    const truncated = input.until === undefined
    return {
      profile: { screen_name: 'NASA', name: 'NASA' },
      posts,
      meta: { handle: input.handle, count: posts.length, until: new Date().toISOString(), truncated, next_until: truncated ? NEXT_UNTIL : undefined, archive: { served: 0, walked: ['refresh'] }, pages: 1 },
    } as never
  })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('anonymous bulk imports: 3 per hour and 5 per day per address', () => {
  test('the 4th request in an hour is refused by import-ip, with the problem shape and headers', async () => {
    const ip = '198.51.100.1'
    for (let i = 0; i < 3; i += 1) expect((await http(ip)).res.statusCode, `request ${i + 1}`).toBe(200)
    const refused = await http(ip)
    expect(refused.res.statusCode).toBe(429)
    expect(refused.json).toMatchObject({ code: 'rate_limited', status: 429, detail: 'Too many bulk imports from this address: 3 per hour.', retry_after: 3300 })
    expect(refused.res.getHeader('Retry-After')).toBe('3300')
    expect(String(refused.res.getHeader('RateLimit'))).toContain('"import-ip";r=0;t=3300')
    expect(String(refused.res.getHeader('RateLimit-Policy'))).toContain('"import-ip";q=3;w=3600')
    expect(String(refused.res.getHeader('RateLimit-Policy'))).toContain('"import-ip-day";q=5;w=86400')
    expect(refused.res.getHeader('Cache-Control')).toBe('no-store')
    expect(imports()).toBe(3)
    // The refusal spent nothing from the day.
    expect(await count(`import:ip-day:${ip}`, 86_400)).toBe(3)
  })

  test('the 6th request in a day is refused by import-ip-day, and spends no hourly unit', async () => {
    const ip = '198.51.100.2'
    for (let i = 0; i < 3; i += 1) expect((await http(ip)).res.statusCode).toBe(200)
    vi.setSystemTime(START + HOUR)
    for (let i = 0; i < 2; i += 1) expect((await http(ip)).res.statusCode, `request ${i + 4}`).toBe(200)
    const refused = await http(ip)
    expect(refused.res.statusCode).toBe(429)
    expect(refused.json).toMatchObject({ code: 'rate_limited', detail: 'Too many bulk imports from this address: 5 per day.' })
    const untilMidnight = String((24 - 11) * 3600 - 5 * 60)
    expect(refused.res.getHeader('Retry-After')).toBe(untilMidnight)
    expect(String(refused.res.getHeader('RateLimit'))).toContain(`"import-ip-day";r=0;t=${untilMidnight}`)
    expect(imports()).toBe(5)
    // The hour window gave its unit back: two spent this hour, not three.
    expect(await count(`import:ip:${ip}`, 3600)).toBe(2)
    // A new day opens both windows again.
    vi.setSystemTime(Date.UTC(2026, 10, 5, 0, 5))
    expect((await http(ip)).res.statusCode).toBe(200)
  })

  test('HTTP and MCP spend one shared allowance, and MCP reports the refusal in its result and headers', async () => {
    const ip = '198.51.100.3'
    expect((await http(ip)).res.statusCode).toBe(200)
    expect((await mcp(ip, { handle: 'NASA' })).json.result.isError).toBe(false)
    expect((await http(ip)).res.statusCode).toBe(200)
    const refused = await mcp(ip, { handle: 'NASA' }, { id: 4 })
    expect(refused.res.statusCode).toBe(200)
    expect(refused.json.id).toBe(4)
    expect(refused.json.result.isError).toBe(true)
    expect(refused.json.result.content[0].text).toBe('Too many bulk imports from this address: 3 per hour. (HTTP 429, code rate_limited, retry after 3300s)')
    expect(refused.res.getHeader('Retry-After')).toBe('3300')
    expect(String(refused.res.getHeader('RateLimit'))).toContain('"import-ip";r=0;t=3300')
    expect(String(refused.res.getHeader('RateLimit-Policy'))).toContain('"import-ip-day";q=5;w=86400')
    // And the HTTP route sees the same spent allowance.
    expect((await http(ip)).res.statusCode).toBe(429)
    expect(imports()).toBe(3)
  })

  test('concurrent requests cannot overspend a window', async () => {
    const ip = '198.51.100.4'
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? http(ip) : mcp(ip, { handle: 'NASA' }, { id: i }))))
    const served = results.filter(({ res, json }) => res.statusCode === 200 && !json.result?.isError).length
    expect(served).toBe(3)
    expect(imports()).toBe(3)
  })

  test('a key holder keeps its own allowance; an invalid key is still refused', async () => {
    const ip = '198.51.100.5'
    for (let i = 0; i < 3; i += 1) await http(ip)
    expect((await http(ip)).res.statusCode).toBe(429)
    const { secret } = await createApiKey('import-quota', 100, 7)
    const headers = { authorization: `Bearer ${secret}` }
    const keyed = await http(ip, {}, headers)
    expect(keyed.res.statusCode).toBe(200)
    expect(String(keyed.res.getHeader('RateLimit-Policy'))).toContain('"import-key";q=7;w=900')
    expect(String(keyed.res.getHeader('RateLimit-Policy'))).not.toContain('import-ip')
    const viaMcp = await mcp(ip, { handle: 'NASA' }, { headers })
    expect(viaMcp.json.result.isError).toBe(false)
    expect(viaMcp.res.getHeader('Cache-Control')).toBe('private, no-store')
    expect(JSON.stringify(viaMcp.json)).not.toContain(secret)
    expect(vi.mocked(importWithHistory).mock.lastCall?.[0].owner).toMatchObject({ kind: 'key' })

    const bogus = { authorization: 'Bearer xmd_not_a_real_key' }
    const httpBogus = await http(ip, {}, bogus)
    expect(httpBogus.res.statusCode).toBe(401)
    expect(httpBogus.json.code).toBe('invalid_key')
    expect((await mcp(ip, { handle: 'NASA' }, { headers: bogus })).res.statusCode).toBe(401)
  })
})

describe('the x_md_import_posts tool', () => {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === 'x_md_import_posts')!
  const validate = new Ajv2020({ strict: false }).compile(tool.outputSchema)

  test('returns the HTTP body and a continuation that can be passed straight back, in both eras', async () => {
    const ip = '198.51.100.6'
    const args = { handle: 'NASA', since: '2026-11-01', max_posts: 20 }
    const first = await mcp(ip, args)
    const result = first.json.result
    expect(result.isError).toBe(false)
    expect(validate(result.structuredContent), JSON.stringify(validate.errors)).toBe(true)
    expect(result.structuredContent.next_arguments).toEqual({ ...args, until: NEXT_UNTIL })
    expect(JSON.parse(result.content[0].text)).toMatchObject({ posts: result.structuredContent.posts, meta: { next_until: NEXT_UNTIL } })
    // Legacy results keep their own shape.
    expect(result.resultType).toBeUndefined()
    expect(vi.mocked(importWithHistory).mock.lastCall?.[0]).toMatchObject({ handle: 'NASA', maxPosts: 20, since: new Date('2026-11-01T00:00:00Z'), until: undefined })

    const next = await mcp(ip, result.structuredContent.next_arguments, { modern: true })
    expect(next.res.statusCode).toBe(200)
    expect(next.json.result.isError).toBe(false)
    expect(next.json.result.resultType).toBe('complete')
    // A per-caller tool result carries no shared freshness hint.
    expect(next.json.result.ttlMs).toBeUndefined()
    expect(next.json.result.cacheScope).toBeUndefined()
    expect(vi.mocked(importWithHistory).mock.lastCall?.[0]).toMatchObject({ handle: 'NASA', maxPosts: 20, until: new Date(NEXT_UNTIL) })
    expect(next.json.result.structuredContent.next_arguments).toBeUndefined()
    // Each continuation is one import.
    expect(await count(`import:ip:${ip}`, 3600)).toBe(2)
  })

  test('defaults to the 100-post per-call cap', async () => {
    await mcp('198.51.100.7', { handle: '@NASA' })
    expect(vi.mocked(importWithHistory).mock.lastCall?.[0]).toMatchObject({ handle: 'NASA', maxPosts: 100 })
  })

  test('invalid input is refused before it spends an import', async () => {
    const ip = '198.51.100.8'
    const reversed = await mcp(ip, { handle: 'NASA', since: '2026-11-04', until: '2026-11-01' })
    expect(reversed.json.result.isError).toBe(true)
    expect(reversed.json.result.content[0].text).toContain('code invalid_option')
    const badDate = await mcp(ip, { handle: 'NASA', since: 'yesterday' })
    expect(badDate.json.result.content[0].text).toContain('`since` must be an ISO date')
    const tooMany = await mcp(ip, { handle: 'NASA', max_posts: 101 })
    expect(tooMany.json.error.code).toBe(-32602)
    const unknown = await mcp(ip, { handle: 'NASA', concurrency: 4 })
    expect(unknown.json.error.code).toBe(-32602)
    expect(imports()).toBe(0)
    expect(await count(`import:ip:${ip}`, 3600)).toBe(0)
  })
})
