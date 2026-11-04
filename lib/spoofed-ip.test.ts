import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const fetchSearchProfiles = vi.fn()
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('@the-convocation/twitter-scraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@the-convocation/twitter-scraper')>()
  return {
    ...actual,
    Scraper: class { setCookies = vi.fn(async () => {}); fetchSearchProfiles = fetchSearchProfiles },
  }
})

import handler from '../api/browse.js'
import { resetMemoryCache } from './cache.js'
import { resetKv } from './kv.js'
import { ACCOUNT_IP } from './quotas.js'
import { resetRateLimits } from './ratelimit.js'
import { resetXSessions } from './xsearch.js'

function exchange(q: string, ip: string) {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'
  req.url = '/api/browse'
  req.query = { resource: 'search', feed: 'users', q, via: 'route' }
  req.headers = { host: 'mdfromx.com', accept: 'application/json', 'x-real-ip': ip }
  const res = new ServerResponse(req) as VercelResponse
  res.status = code => { res.statusCode = code; return res }
  res.send = () => { res.emit('finish'); return res }
  return { req, res }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubEnv('CACHE_PERSIST', '0')
  vi.stubEnv('VERCEL', '')
  resetMemoryCache()
  resetRateLimits()
  resetKv()
  resetXSessions([{ id: 'a', authToken: 'tokA', ct0: 'csrfA' }, { id: 'b', authToken: 'tokB', ct0: 'csrfB' }])
  fetchSearchProfiles.mockResolvedValue({ profiles: [] })
})

afterEach(() => {
  resetXSessions(undefined)
  vi.unstubAllEnvs()
})

test('a fresh spoofed x-real-ip per request does not buy a fresh account-backed allowance', async () => {
  const statuses: number[] = []
  for (let i = 0; i < 100; i++) {
    const { req, res } = exchange(`ai ${i}`, `10.0.${i >> 8}.${i & 255}`)
    await handler(req, res)
    statuses.push(res.statusCode)
  }
  expect(fetchSearchProfiles.mock.calls.length).toBeLessThanOrEqual(ACCOUNT_IP.quota)
  expect(statuses.filter(status => status === 429).length).toBeGreaterThanOrEqual(100 - ACCOUNT_IP.quota)
})
