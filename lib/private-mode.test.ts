import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import convertHandler from '../api/convert.js'
import { convertTweet } from './converter.js'
import { resolveCaller } from './apiauth.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./converter.js', async importOriginal => ({ ...await importOriginal<any>(), convertTweet: vi.fn() }))
vi.mock('./apiauth.js', async importOriginal => ({ ...await importOriginal<any>(), resolveCaller: vi.fn() }))

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
const posts = [{ id: '123', text: 'a post', author: { screen_name: 'user', name: 'User' }, url: 'https://x.com/user/status/123' }]

function exchange(headers: Record<string, string>, query: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket()) as any
  req.method = 'GET'
  req.query = { handle: 'user', id: '123', ...query }
  req.headers = { host: 'x.pcstyle.dev', 'x-forwarded-proto': 'https', ...headers }
  const res = new ServerResponse(req) as any
  res.body = undefined
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = (body: string) => { res.body = body; res.emit('finish'); return res }
  res.end = (body?: string) => { if (body !== undefined) res.body = body; res.emit('finish'); return res }
  return { req, res }
}

beforeEach(() => {
  vi.stubEnv('X_MD_REQUIRE_API_KEY', '1')
  vi.mocked(convertTweet).mockResolvedValue({ posts, body: 'rendered', warnings: [], canonicalUrl: 'https://x.com/user/status/123', format: 'markdown', postCount: 1, source: 'fxtwitter', cache: 'hit', compact: true })
  vi.mocked(resolveCaller).mockResolvedValue({ caller: { kind: 'public' }, status: 'anonymous', ip: '192.0.2.1' })
})
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

test('private mode: a preview bot gets the Open Graph card without a key', async () => {
  const { req, res } = exchange({ 'user-agent': DISCORD, accept: '*/*' })
  await convertHandler(req, res)
  expect(res.statusCode).toBe(200)
  expect(String(res.getHeader('Content-Type'))).toContain('text/html')
})

test('private mode: the same user agent asking for data is gated like anyone else', async () => {
  for (const query of [{ format: 'json' }, { format: 'markdown' }]) {
    const { req, res } = exchange({ 'user-agent': DISCORD, accept: '*/*' }, query)
    await convertHandler(req, res)
    expect(res.statusCode).toBe(401)
  }
  const negotiated = exchange({ 'user-agent': DISCORD, accept: 'application/json' })
  await convertHandler(negotiated.req, negotiated.res)
  expect(negotiated.res.statusCode).toBe(401)
  const anonymous = exchange({ accept: 'text/markdown' })
  await convertHandler(anonymous.req, anonymous.res)
  expect(anonymous.res.statusCode).toBe(401)
})
