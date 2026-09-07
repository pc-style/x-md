import { describe, expect, test } from 'vitest'
import { run } from '../scripts/browse-x.ts'

const response = (body = 'ok', status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'x-source': 'stub', ...headers } })

const invoke = async (args: string[]) => {
  const output: string[] = []
  await run(args, { X_API_BASE: 'https://example.test' }, async (input, init) => {
    const url = String(input)
    expect(init?.headers).toEqual({ Accept: url.includes('format=json') ? 'application/json' : 'text/markdown' })
    return response()
  }, { write: (value) => output.push(value) })
  return output.join('')
}

describe('browse-x CLI', () => {
  test('builds a status request and prints headers', async () => {
    const output = await invoke(['status', 'https://x.com/a/status/1', '--thread', 'full', '--headers'])
    expect(output).toContain('HTTP 200')
    expect(output).toContain('x-source: stub')
    expect(output).toMatch(/ok\n$/)
  })

  test('encodes search and list options', async () => {
    let requested: URL | undefined
    const output: string[] = []
    await run(
      ['search', 'from:test release', '--feed', 'media', '--page', '3', '--limit', '10', '--compact'],
      { X_API_BASE: 'https://example.test' },
      async (input) => {
        requested = new URL(String(input))
        return response()
      },
      { write: (value) => output.push(value) },
    )

    expect(requested?.pathname).toBe('/search')
    expect(Object.fromEntries(requested?.searchParams ?? [])).toEqual({
      q: 'from:test release',
      full: 'false',
      page: '3',
      limit: '10',
      feed: 'media',
    })
    expect(output.join('')).toBe('ok\n')
  })

  test('accepts every supported feed and rejects limits above 20', async () => {
    for (const feed of ['latest', 'top', 'photos', 'videos', 'users', 'media']) {
      await expect(invoke(['search', 'test', '--feed', feed, '--limit', '20'])).resolves.toBe('ok\n')
    }
    await expect(invoke(['search', 'test', '--limit', '21'])).rejects.toMatchObject({ code: 2 })
  })

  test('rejects invalid option combinations', async () => {
    await expect(invoke(['status', 'https://x.com/a/status/1', '--json', '--format', 'markdown'])).rejects.toThrow(
      '--json conflicts with --format markdown',
    )
    await expect(invoke(['profile', 'test', '--thread', 'full'])).rejects.toThrow('status options are only valid')
    await expect(invoke(['status', '--help'])).rejects.toMatchObject({ code: 0 })
    await expect(invoke(['status', 'https://example.test/a/status/1'])).rejects.toMatchObject({ code: 2 })
    await expect(invoke(['https://example.test/a/status/1'])).rejects.toMatchObject({ code: 2 })
    await expect(invoke(['status', 'https://x.com/a/status/1/photo/1'])).rejects.toMatchObject({ code: 2 })
    await expect(invoke(['https://x.com/a/status/not-a-number'])).rejects.toMatchObject({ code: 2 })
  })

  test('supports mobile Twitter status URLs and encodes handles', async () => {
    let requested = ''
    const fetcher = async (input: RequestInfo | URL) => {
      requested = String(input)
      return response()
    }

    await run(['status', 'https://mobile.twitter.com/a/status/1'], { X_API_BASE: 'https://example.test' }, fetcher)
    expect(requested).toContain('url=https%3A%2F%2Fmobile.twitter.com%2Fa%2Fstatus%2F1')

    await run(['profile', 'name/with?delimiters'], { X_API_BASE: 'https://example.test' }, fetcher)
    expect(new URL(requested).pathname).toBe('/name%2Fwith%3Fdelimiters')
  })

  test('falls back from an empty base and sends configured API authentication', async () => {
    let requested = ''
    let requestHeaders: HeadersInit | undefined
    await run(
      ['profile', 'test'],
      { X_API_BASE: '', X_MD_API_BASE: 'https://fallback.test', X_MD_API_KEY: 'secret' },
      async (input, init) => {
        requested = String(input)
        requestHeaders = init?.headers
        return response()
      },
    )

    expect(requested).toBe('https://fallback.test/test')
    expect(requestHeaders).toEqual({ Accept: 'text/markdown', Authorization: 'Bearer secret' })
  })

  test('preserves network and rate-limit diagnostics', async () => {
    await expect(
      run(['profile', 'test'], { X_API_BASE: 'https://example.test' }, async () => {
        throw new Error('connection refused')
      }),
    ).rejects.toThrow('connection refused')

    await expect(
      run(
        ['search', 'test'],
        { X_API_BASE: 'https://example.test' },
        async () => response('slow down', 429, { 'retry-after': '30' }),
      ),
    ).rejects.toMatchObject({ code: 3, message: expect.stringContaining('retry-after: 30') })
  })

  test('preserves API errors', async () => {
    await expect(run(['profile', 'test'], { X_API_BASE: 'https://example.test' }, async () => response('not found', 404))).rejects.toThrow(
      'HTTP 404',
    )
  })
})
