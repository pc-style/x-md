import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import middleware from '../middleware'

const renderOgImage = vi.hoisted(() => vi.fn(async () => new Uint8Array([137, 80, 78, 71, Math.floor(Math.random() * 256)])))
vi.mock('../.cache/blume-og.mjs', () => ({ renderOgImage }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile) }
})
const { default: siteHandler } = await import('../api/site')

let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'xmd-site-og-'))
  await mkdir(join(root, 'public'))
  await mkdir(join(root, 'dist'))
  await writeFile(join(root, 'public/logo.svg'), '<svg/>')
  vi.spyOn(process, 'cwd').mockReturnValue(root)
})
afterAll(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function request(method: string, query: Record<string, string>, host = 'future.example') {
  const req = new IncomingMessage(new Socket()) as any
  req.method = method
  req.url = `/api/site?${new URLSearchParams(query)}`
  req.query = query
  req.headers = { host, accept: 'image/png' }
  const res = new ServerResponse(req) as any
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = (body: Buffer) => { res.body = body; return res }
  res.end = () => res
  await siteHandler(req, res)
  return res
}

test('cache-busted OG requests render once, reuse fonts and logo, and HEAD skips the render', async () => {
  const head = await request('HEAD', { path: '/og.png', cb: '0' })
  expect(head.statusCode).toBe(200)
  expect(head.getHeader('content-type')).toBe('image/png')
  expect(renderOgImage).not.toHaveBeenCalled()

  const first = await request('GET', { path: '/og.png', cb: '1' })
  const second = await request('GET', { path: '/og.png', cb: '2' })
  for (const res of [first, second]) {
    expect(res.statusCode).toBe(200)
    expect(res.getHeader('content-type')).toBe('image/png')
  }
  expect(Buffer.compare(first.body, second.body)).toBe(0)
  expect(renderOgImage).toHaveBeenCalledTimes(1)

  expect((await request('GET', { path: '/og.png' }, 'other.example')).statusCode).toBe(200)
  expect(renderOgImage).toHaveBeenCalledTimes(2)
  const logoReads = vi.mocked(fs.readFile).mock.calls.filter(([file]) => String(file).endsWith('logo.svg'))
  expect(logoReads).toHaveLength(1)
})

test('direct /api/site requests drop every parameter except path', () => {
  const response = middleware(new Request('https://future.example/api/site?path=%2Fog.png&cb=1'))
  expect(response.status).toBe(308)
  expect(new URL(response.headers.get('location')!).search).toBe('?path=%2Fog.png')
  expect(middleware(new Request('https://future.example/api/site?path=%2Fog.png')).headers.get('location')).toBeNull()
})
