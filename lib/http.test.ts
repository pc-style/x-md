import { describe, expect, test } from 'vitest'
import { requestOrigin, wantsJson, wantsMarkdown } from './http.js'

describe('requestOrigin', () => {
  test('uses the request host for known public and local hosts', () => {
    expect(
      requestOrigin({
        headers: { 'x-forwarded-proto': 'https', host: 'x.pcstyle.dev' },
      }),
    ).toBe('https://x.pcstyle.dev')
    expect(
      requestOrigin({
        headers: { host: 'localhost:5173' },
        protocol: 'http',
      }),
    ).toBe('http://localhost:5173')
  })

  test('ignores a forged forwarded host', () => {
    expect(
      requestOrigin({
        headers: { 'x-forwarded-host': 'evil.example', host: 'x.pcstyle.dev' },
      }),
    ).toBe('https://x.pcstyle.dev')
  })

  test('falls back to the hosted origin', () => {
    expect(requestOrigin({ headers: {} })).toBe('https://x.pcstyle.dev')
    expect(requestOrigin({ headers: { host: 'evil.example' } })).toBe('https://x.pcstyle.dev')
  })
})

describe('wantsMarkdown', () => {
  test('gives an explicit format precedence over Accept', () => {
    expect(wantsMarkdown('json', 'text/markdown')).toBe(false)
    expect(wantsMarkdown('markdown', 'application/json')).toBe(true)
  })

  test('uses Accept when no format is explicit', () => {
    expect(wantsMarkdown(undefined, 'text/markdown')).toBe(true)
    expect(wantsMarkdown(undefined, 'text/html')).toBe(false)
  })
})

describe('wantsJson', () => {
  test('gives an explicit format precedence over Accept', () => {
    expect(wantsJson('markdown', 'application/json')).toBe(false)
    expect(wantsJson('json', 'text/markdown')).toBe(true)
  })

  test('uses Accept when no format is explicit', () => {
    expect(wantsJson(undefined, 'application/json')).toBe(true)
    expect(wantsJson(undefined, 'text/markdown')).toBe(false)
  })
})

describe('parseJsonBody', () => {
  test('accepts empty, objects, and valid JSON; rejects malformed JSON', async () => {
    const { parseJsonBody } = await import('./http.js')
    expect(parseJsonBody(undefined)).toEqual({ ok: true, value: {} })
    expect(parseJsonBody('')).toEqual({ ok: true, value: {} })
    expect(parseJsonBody({ a: 1 })).toEqual({ ok: true, value: { a: 1 } })
    expect(parseJsonBody('{"label":"x"}')).toEqual({ ok: true, value: { label: 'x' } })
    expect(parseJsonBody('{oops')).toEqual({ ok: false })
  })
})
