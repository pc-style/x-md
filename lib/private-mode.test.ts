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
  req.headers = { host: 'mdfromx.com', 'x-forwarded-proto': 'https', ...headers }
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

test('a presented key that does not verify is refused even in public mode', async () => {
  vi.stubEnv('X_MD_REQUIRE_API_KEY', '')
  vi.mocked(resolveCaller).mockResolvedValueOnce({ caller: { kind: 'public', ip: '192.0.2.1' }, status: 'invalid', ip: '192.0.2.1' })
  const { req, res } = exchange({ accept: 'application/json', authorization: 'Bearer nope' })
  await convertHandler(req, res)
  expect(res.statusCode).toBe(401)
  expect(JSON.parse(res.body).code).toBe('invalid_key')
  expect(convertTweet).not.toHaveBeenCalled()
})

test('an Accept that refuses every representation is 406, but a preview bot keeps its card', async () => {
  vi.stubEnv('X_MD_REQUIRE_API_KEY', '')
  const refused = exchange({ accept: 'text/markdown;q=0, application/json;q=0, text/html;q=0' })
  await convertHandler(refused.req, refused.res)
  expect(refused.res.statusCode).toBe(406)
  expect(JSON.parse(refused.res.body).code).toBe('not_acceptable')
  expect(convertTweet).not.toHaveBeenCalled()

  const card = exchange({ 'user-agent': DISCORD, accept: '*/*;q=0' })
  await convertHandler(card.req, card.res)
  expect(card.res.statusCode).toBe(200)
  expect(String(card.res.getHeader('Content-Type'))).toContain('text/html')

  // An explicit format outranks Accept, as it always has.
  const explicit = exchange({ accept: '*/*;q=0' }, { format: 'markdown' })
  await convertHandler(explicit.req, explicit.res)
  expect(explicit.res.statusCode).toBe(200)
})

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

test('private mode: only a keyless Open Graph card is exempt, and a valid key always passes', async () => {
  const card = exchange({ 'user-agent': 'Discordbot/2.0', accept: '*/*' }, { handle: 'alice', id: '123' })
  await convertHandler(card.req, card.res)
  expect(card.res.statusCode).toBe(200)
  expect(String(card.res.getHeader('Content-Type'))).toContain('text/html')
  expect(card.res.body).toMatch(/<meta property="og:description" content="[^"]*a post/)

  // URL-selected cards expose the same public metadata as a spoofable bot UA.
  const explicitCard = exchange({ 'user-agent': 'curl/8', accept: '*/*' }, { embed: 'card' })
  await convertHandler(explicitCard.req, explicitCard.res)
  expect(explicitCard.res.statusCode).toBe(200)
  expect(String(explicitCard.res.getHeader('Content-Type'))).toContain('text/html')
  const explicitData = exchange({ 'user-agent': 'curl/8', accept: 'application/json' }, { embed: 'card' })
  await convertHandler(explicitData.req, explicitData.res)
  expect(explicitData.res.statusCode).toBe(401)

  const curl = exchange({ 'user-agent': 'curl/8', accept: '*/*' }, { handle: 'alice', id: '123' })
  await convertHandler(curl.req, curl.res)
  expect(curl.res.statusCode).toBe(401)
  expect(String(curl.res.getHeader('Content-Type'))).toContain('application/problem+json')

  const json = exchange({ 'user-agent': 'Discordbot/2.0', accept: '*/*' }, { handle: 'alice', id: '123', format: 'json' })
  await convertHandler(json.req, json.res)
  expect(json.res.statusCode).toBe(401)

  // A caller that presents a credential is an API caller, not a link unfurler:
  // a bad or unverifiable key must not fall back to the preview-bot exemption.
  for (const status of ['invalid', 'unverified'] as const) {
    vi.mocked(resolveCaller).mockResolvedValueOnce({ caller: { kind: 'public', ip: '192.0.2.1' }, status, ip: '192.0.2.1' })
    const spoofed = exchange({ 'user-agent': 'Discordbot/2.0', accept: '*/*', authorization: 'Bearer nope' }, { handle: 'alice', id: '123' })
    await convertHandler(spoofed.req, spoofed.res)
    expect(spoofed.res.statusCode).toBe(401)
  }
  // An unsupported scheme resolves as anonymous but is still a credential.
  const basic = exchange({ 'user-agent': 'Discordbot/2.0', accept: '*/*', authorization: 'Basic abc' }, { handle: 'alice', id: '123' })
  await convertHandler(basic.req, basic.res)
  expect(basic.res.statusCode).toBe(401)

  for (const [ua, query] of [['Discordbot/2.0', {}], ['curl/8', {}], ['Discordbot/2.0', { format: 'json' }]] as const) {
    vi.mocked(resolveCaller).mockResolvedValueOnce({ caller: { kind: 'key', id: 'k1', limit: 100 }, status: 'valid', ip: '192.0.2.1' })
    const keyed = exchange({ 'user-agent': ua, accept: '*/*', authorization: 'Bearer good' }, { handle: 'alice', id: '123', ...query })
    await convertHandler(keyed.req, keyed.res)
    expect(keyed.res.statusCode).toBe(200)
  }
})
