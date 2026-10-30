import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { VercelRequest, VercelResponse } from '@vercel/node'

interface Batch {
  api_key: string
  batch: { event: string; distinct_id: string; properties: Record<string, unknown> }[]
}
const sent: { url: string; body: Batch }[] = []

function exchange() {
  const req = new IncomingMessage(new Socket()) as VercelRequest
  req.url = '/api/browse?q=private-query'
  req.headers = { authorization: 'Bearer private-token' }
  return { req, res: new ServerResponse(req) as VercelResponse }
}

beforeEach(() => {
  vi.resetModules()
  sent.length = 0
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('POSTHOG_PROJECT_TOKEN', 'phc_test')
  vi.stubEnv('POSTHOG_HOST', 'https://eu.i.posthog.com')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', '')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', '')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = typeof init.body === 'string' ? init.body : gunzipSync(Buffer.from(init.body as Uint8Array)).toString()
    sent.push({ url: String(url), body: JSON.parse(body) })
    return new Response('{"status":"Ok"}', { status: 200 })
  }))
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

test('flushes a rejected handler through the real SDK before rethrowing its original error', async () => {
  const { withErrorTracking } = await import('./error-tracking')
  const { req, res } = exchange()
  const error = new TypeError('Failed https://upstream.invalid/posts?token=private-query#private-hash')
  error.stack = `${error.name}: ${error.message}\n    at fetchPost (https://upstream.invalid/handler.js?token=private-frame:1:12)`
  await expect(withErrorTracking(() => { throw error })(req, res)).rejects.toBe(error)
  expect(sent).toHaveLength(1)
  expect(sent[0].url).toBe('https://eu.i.posthog.com/batch/')
  expect(sent[0].body.api_key).toBe('phc_test')
  expect(sent[0].body.batch).toHaveLength(1)
  const event = sent[0].body.batch[0]
  expect(event).toMatchObject({ event: '$exception', distinct_id: 'server', properties: {
    environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null,
    $exception_list: [{ type: 'TypeError', value: 'Failed https://upstream.invalid/posts' }],
  } })
  expect(JSON.stringify(sent)).not.toContain('private-')
})

test.each(['development', 'preview'])('does not capture handler errors in %s', async environment => {
  vi.stubEnv('VERCEL_ENV', environment)
  const { withErrorTracking } = await import('./error-tracking')
  const { req, res } = exchange()
  const error = new Error('test failure')
  await expect(withErrorTracking(async () => { throw error })(req, res)).rejects.toBe(error)
  expect(fetch).not.toHaveBeenCalled()
})

test.each(['POSTHOG_PROJECT_TOKEN', 'POSTHOG_HOST'])('preserves the error when %s is missing', async name => {
  vi.stubEnv(name, '')
  const { withErrorTracking } = await import('./error-tracking')
  const { req, res } = exchange()
  const error = new Error('test failure')
  await expect(withErrorTracking(() => { throw error })(req, res)).rejects.toBe(error)
  expect(fetch).not.toHaveBeenCalled()
})

test('supports the Vercel Marketplace runtime variables', async () => {
  vi.stubEnv('POSTHOG_PROJECT_TOKEN', '')
  vi.stubEnv('POSTHOG_HOST', '')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN', 'phc_marketplace')
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://us.i.posthog.com')
  const { withErrorTracking } = await import('./error-tracking')
  const { req, res } = exchange()
  const error = new Error('test failure')
  await expect(withErrorTracking(() => { throw error })(req, res)).rejects.toBe(error)
  expect(sent[0].url).toBe('https://us.i.posthog.com/batch/')
  expect(sent[0].body.api_key).toBe('phc_marketplace')
})

test('does not initialize telemetry for a successful handler', async () => {
  const { withErrorTracking } = await import('./error-tracking')
  const { req, res } = exchange()
  const handler = vi.fn(() => 'ok')
  await expect(withErrorTracking(handler)(req, res)).resolves.toBe('ok')
  expect(handler).toHaveBeenCalledWith(req, res)
  expect(fetch).not.toHaveBeenCalled()
})

test('delivery failures never replace the handler error', async () => {
  vi.mocked(fetch).mockRejectedValue(new Error('Telemetry unavailable'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { withErrorTracking } = await import('./error-tracking')
  const { req, res } = exchange()
  const error = new Error('original failure')
  await expect(withErrorTracking(() => { throw error })(req, res)).rejects.toBe(error)
  expect(fetch).toHaveBeenCalledTimes(1)
})
