import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchContextDevStatus } from './contextdev.js'
import { ConvertError } from './errors.js'

const ORIGINAL_KEY = process.env.CONTEXT_DEV_API_KEY

describe('fetchContextDevStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
  })

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CONTEXT_DEV_API_KEY
    else process.env.CONTEXT_DEV_API_KEY = ORIGINAL_KEY
    vi.unstubAllGlobals()
  })

  test('scrapes a status URL through Context.dev markdown API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          markdown: '# X\n\n@alice\n\nReal post body\n\n12 likes',
          url: 'https://x.com/alice/status/123',
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tweet = await fetchContextDevStatus('alice', '123')

    expect(tweet).toEqual({
      id: '123',
      url: 'https://x.com/alice/status/123',
      text: 'Real post body',
      author: { name: 'alice', screen_name: 'alice', url: 'https://x.com/alice' },
    })

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://api.context.dev/v1/web/scrape/markdown')
    expect(calledUrl.searchParams.get('url')).toBe('https://x.com/alice/status/123')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer ctxt_secret_test' }),
    })
  })

  test('is disabled when CONTEXT_DEV_API_KEY is missing', async () => {
    delete process.env.CONTEXT_DEV_API_KEY

    await expect(fetchContextDevStatus('alice', '123')).rejects.toMatchObject({
      status: 502,
      code: 'contextdev_disabled',
    } satisfies Partial<ConvertError>)
  })

  test('wraps Context.dev API errors as ConvertError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
      ),
    )

    await expect(fetchContextDevStatus('alice', '123')).rejects.toMatchObject({
      status: 502,
      code: 'contextdev_error',
      message: 'rate limited',
    } satisfies Partial<ConvertError>)
  })
})
