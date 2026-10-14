import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import type { Connect, ViteDevServer } from 'vite'
import { expect, test, vi } from 'vitest'

vi.mock('../lib/ratelimit-headers', async (original) => ({
  ...await original<typeof import('../lib/ratelimit-headers')>(),
  chargeRequestQuota: vi.fn(),
}))

import { chargeRequestQuota } from '../lib/ratelimit-headers'
import { apiDevPlugin } from './vite-api-plugin'

/** The connect middleware the plugin installs on the dev server. */
function middleware(): Connect.NextHandleFunction {
  let installed: Connect.NextHandleFunction | undefined
  const server = { middlewares: { use: (fn: Connect.NextHandleFunction) => { installed = fn } } } as unknown as ViteDevServer
  const configure = apiDevPlugin().configureServer as (server: ViteDevServer) => void
  configure(server)
  if (!installed) throw new Error('the plugin installed no middleware')
  return installed
}

test('a charge that fails while browse is rejecting the input is not an unhandled rejection', async () => {
  const rejections: unknown[] = []
  const listeners = process.listeners('unhandledRejection')
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (reason) => { rejections.push(reason) })
  try {
    const failure = new Error('store unreachable')
    // The verdict fails only after browse has already rejected `limit`, before it awaited the verdict.
    vi.mocked(chargeRequestQuota).mockReturnValueOnce(new Promise((_resolve, reject) => setTimeout(() => reject(failure), 0)))
    const req = new IncomingMessage(new Socket())
    req.method = 'GET'
    req.url = '/api/browse?resource=followers&handle=ada&limit=0'
    req.headers = { host: 'localhost:5173', accept: 'text/markdown' }
    const res = new ServerResponse(req)
    const passed = new Promise<unknown>((resolve) => { middleware()(req, res, resolve) })
    expect(await passed).toBe(failure)
    // Node reports an orphaned rejection only once the microtask queue has drained.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  } finally {
    process.removeAllListeners('unhandledRejection')
    for (const listener of listeners) process.on('unhandledRejection', listener)
  }
  expect(rejections).toEqual([])
})
