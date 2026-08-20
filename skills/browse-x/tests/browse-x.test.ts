import { describe, expect, test } from 'vitest'
import { run } from '../scripts/browse-x.ts'

const response = (body = 'ok', status = 200) =>
  new Response(body, { status, headers: { 'x-source': 'stub' } })

const invoke = async (args: string[]) => {
  const output: string[] = []
  await run(args, { X_API_BASE: 'https://example.test' }, async (input, init) => {
    const url = String(input)
    expect(init?.headers).toEqual({ Accept: url.includes('format=json') ? 'application/json' : 'text/markdown' })
    return response()
  }, { write: (value) => output.push(value), error: () => undefined })
  return output.join('')
}

describe('browse-x CLI', () => {
  test('builds a status request and prints headers', async () => {
    const output = await invoke(['status', 'https://x.com/a/status/1', '--thread', 'full', '--headers'])
    expect(output).toContain('HTTP/1.1 200')
    expect(output).toContain('x-source: stub')
    expect(output).toMatch(/ok\n$/)
  })

  test('encodes search and list options', async () => {
    const output = await invoke(['search', 'from:test release', '--feed', 'media', '--page', '3', '--limit', '10'])
    expect(output).toBe('ok\n')
  })

  test('rejects invalid option combinations', async () => {
    await expect(invoke(['status', 'https://x.com/a/status/1', '--json', '--format', 'markdown'])).rejects.toThrow(
      '--json conflicts with --format markdown',
    )
    await expect(invoke(['profile', 'test', '--thread', 'full'])).rejects.toThrow('status options are only valid')
  })

  test('preserves API errors', async () => {
    await expect(run(['profile', 'test'], { X_API_BASE: 'https://example.test' }, async () => response('not found', 404))).rejects.toThrow(
      'HTTP 404',
    )
  })
})
