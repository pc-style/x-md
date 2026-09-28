import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { expect, test, vi } from 'vitest'
import handler from '../api/import.js'
import { importWithHistory } from './history.js'
import { ConvertError } from './errors.js'
import { rateLimit, refundRateLimit } from './ratelimit.js'

vi.mock('./history.js', async original => {
  const actual = await original<typeof import('./history.js')>()
  return { ...actual, importWithHistory: vi.fn() }
})

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))
vi.mock('./ratelimit.js', async original => {
  const actual = await original<typeof import('./ratelimit.js')>()
  return { ...actual, rateLimit: vi.fn(actual.rateLimit), refundRateLimit: vi.fn(actual.refundRateLimit) }
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

test.each([{with_replies:'yes'},{only_replies:'true',with_replies:'false'},{max_posts:'500',limit:'400'},{since:'2026-02-30'},{concurrency:'33'}])('rejects invalid import options before spending an import: %j', async options => {
  vi.mocked(rateLimit).mockClear()
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'; req.query = { handle:'ada', ...options }; req.headers = {accept:'application/json'}
  const res = new ServerResponse(req) as VercelResponse
  let body = ''
  res.status = code => {res.statusCode=code;return res};res.send=value=>{body=String(value);return res}
  await handler(req,res)
  expect(res.statusCode).toBe(400)
  expect(JSON.parse(body).code).toBe('invalid_option')
  expect(vi.mocked(rateLimit).mock.calls.some(([key])=>key.startsWith('import:'))).toBe(false)
})

test.each(['json', 'ndjson'])('refunds busy %s admission but keeps upstream failure charges', async format => {
  for (const code of ['import_busy', 'upstream_unavailable'] as const) {
    vi.mocked(refundRateLimit).mockClear()
    vi.mocked(importWithHistory).mockRejectedValueOnce(new ConvertError(503, 'Unavailable', code, 5))
    const req = new IncomingMessage(new Socket()) as VercelRequest
    req.method = 'GET'; req.query = { handle: 'ada', format }; req.headers = { accept: 'application/json' }
    const res = new ServerResponse(req) as VercelResponse
    res.status = status => { res.statusCode = status; return res }
    res.send = () => res
    vi.spyOn(res, 'flushHeaders').mockImplementation(() => {})
    vi.spyOn(res, 'write').mockImplementation(() => true)
    vi.spyOn(res, 'end').mockImplementation(() => res)
    await handler(req, res)
    expect(refundRateLimit).toHaveBeenCalledTimes(code === 'import_busy' ? 1 : 0)
    if (code === 'import_busy') expect(refundRateLimit).toHaveBeenCalledWith('import:ip:unknown', 900, expect.any(Number))
  }
})
