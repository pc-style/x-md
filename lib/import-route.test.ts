import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { expect, test, vi } from 'vitest'
import handler from '../api/import.js'
import { rateLimit } from './ratelimit.js'

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./ratelimit.js', async original => {
  const actual = await original<typeof import('./ratelimit.js')>()
  return { ...actual, rateLimit: vi.fn(actual.rateLimit) }
})

test.each(['json', 'ndjson'])('reversed %s ranges return 400 before spending an import or streaming', async format => {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'
  req.query = { handle: 'ada', since: '2026-09-10', until: '2026-09-09', format }
  req.headers = { host: 'x.pcstyle.dev', accept: 'application/json' }
  const res = new ServerResponse(req) as VercelResponse
  let body = ''
  res.status = code => { res.statusCode = code; return res }
  res.send = value => { body = String(value); return res }
  const flush = vi.spyOn(res, 'flushHeaders')
  await handler(req, res)
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(body).code).toBe('invalid_option')
  expect(flush).not.toHaveBeenCalled()
  expect(vi.mocked(rateLimit).mock.calls.some(([key]) => key.startsWith('import:'))).toBe(false)
})
