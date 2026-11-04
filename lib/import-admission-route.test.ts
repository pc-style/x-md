import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { expect, test, vi } from 'vitest'

vi.mock('./fxtwitter.js', async () => {
  const actual = await vi.importActual<typeof import('./fxtwitter.js')>('./fxtwitter.js')
  return { ...actual, fetchFxProfile: vi.fn(), fetchFxProfileStatuses: vi.fn() }
})
vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }))

import handler from '../api/import.js'
import { fetchFxProfile, fetchFxProfileStatuses } from './fxtwitter.js'

function call(query: Record<string, string>, ip: string) {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.method = 'GET'
  req.query = query
  req.headers = { accept: 'application/json', 'x-real-ip': ip }
  const res = new ServerResponse(req) as VercelResponse
  let body = ''
  res.status = code => { res.statusCode = code; return res }
  res.send = value => { body = String(value); return res }
  return { done: handler(req, res).then(() => ({ status: res.statusCode, body })) }
}

test('one address holding long walks cannot starve another address of a fresh import', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  vi.mocked(fetchFxProfile).mockImplementation(async handle => {
    if (handle !== 'jack') await held
    return { screen_name: handle, name: handle, statuses: 5000 }
  })
  vi.mocked(fetchFxProfileStatuses).mockResolvedValue({ results: [{ id: '1', text: 'hi', created_at: new Date().toUTCString(), author: { screen_name: 'jack' } }], attempts: 1 })

  const long = { max_posts: '5000', since: '2006-01-01' }
  const nasa = call({ handle: 'nasa', ...long }, '203.0.113.1')
  await vi.waitFor(() => expect(fetchFxProfile).toHaveBeenCalledWith('nasa', expect.anything(), expect.anything(), expect.anything()))
  const elon = call({ handle: 'elonmusk', ...long }, '203.0.113.1')
  await new Promise(resolve => setTimeout(resolve, 20))

  const jack = await call({ handle: 'jack', max_posts: '50' }, '198.51.100.7').done
  expect(jack.status).toBe(200)
  expect(JSON.parse(jack.body).meta.count).toBe(1)

  release()
  const [first, second] = await Promise.all([nasa.done, elon.done])
  expect(first.status).toBe(200)
  expect(second.status).toBe(503)
  expect(JSON.parse(second.body).code).toBe('import_busy')
})
