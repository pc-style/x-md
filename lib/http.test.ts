import { describe, expect, test } from 'vitest'
import { acceptedRepresentation, requestOrigin, wantsJson, wantsMarkdown } from './http.js'
import { POST_REPRESENTATIONS, acceptPrefersHtml } from './converter.js'

describe('requestOrigin', () => {
  test.each(['www.elon-dont-c-and-d-me-plz.dev', 'future-domain.example'])('supports newly attached host %s', (host) => {
    expect(requestOrigin({ headers: { host } })).toBe(`https://${host}`)
  })
  test('preserves the parallel domain for API discovery and embeds', () => {
    expect(requestOrigin({ headers: { host: 'mdfromx.com', 'x-forwarded-proto': 'https' } }))
      .toBe('https://mdfromx.com')
    expect(requestOrigin({ headers: { host: 'fast.mdfromx.com', 'x-forwarded-proto': 'https' } }))
      .toBe('https://fast.mdfromx.com')
    expect(requestOrigin({ headers: { host: 'mdfromx.com.evil.example' } }))
      .toBe('https://mdfromx.com.evil.example')
  })
  test('uses the request host for known public and local hosts', () => {
    expect(
      requestOrigin({
        headers: { 'x-forwarded-proto': 'https', host: 'mdfromx.com' },
      }),
    ).toBe('https://mdfromx.com')
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
        headers: { 'x-forwarded-host': 'evil.example', host: 'mdfromx.com' },
      }),
    ).toBe('https://mdfromx.com')
  })

  test('falls back to the hosted origin', () => {
    expect(requestOrigin({ headers: {} })).toBe('https://mdfromx.com')
    for (const host of ['evil.example/path', 'user@evil.example', 'evil.example,other.example', 'evil.example\"<>', 'host:99999']) {
      expect(requestOrigin({ headers: { host } })).toBe('https://mdfromx.com')
    }
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

describe('Accept negotiation on data routes', () => {
  // Regression: substring checks served JSON to a caller that refused it with q=0.
  test('an explicitly refused representation is never selected', () => {
    expect(wantsJson(undefined, 'text/html;q=1,application/json;q=0', POST_REPRESENTATIONS)).toBe(false)
    expect(acceptPrefersHtml('text/html;q=1,application/json;q=0')).toBe(true)
    expect(wantsJson(undefined, 'text/markdown;q=1,application/json;q=0')).toBe(false)
    expect(wantsMarkdown(undefined, 'text/markdown;q=1,application/json;q=0')).toBe(true)
    expect(wantsMarkdown(undefined, 'application/json, text/markdown;q=0')).toBe(false)
  })

  test('a wildcard never outranks a type the caller named', () => {
    const accept = 'application/json;q=0.9,text/markdown;q=0,*/*;q=1'
    expect(wantsJson(undefined, accept, POST_REPRESENTATIONS)).toBe(true)
    expect(acceptPrefersHtml(accept)).toBe(false)
  })

  test('refusing every representation is null, not a preference', () => {
    expect(acceptedRepresentation('text/markdown;q=0, application/json;q=0, text/html;q=0', POST_REPRESENTATIONS)).toBeNull()
    expect(acceptedRepresentation('*/*;q=0', POST_REPRESENTATIONS)).toBeNull()
    // Naming nothing on offer still leaves the route its default.
    expect(acceptedRepresentation('image/png', POST_REPRESENTATIONS)).toBeUndefined()
    expect(acceptedRepresentation('', POST_REPRESENTATIONS)).toBeUndefined()
  })

  test('a refused default falls to what a wildcard still accepts', () => {
    expect(wantsMarkdown(undefined, 'text/markdown;q=0, */*', POST_REPRESENTATIONS)).toBe(false)
    expect(wantsJson(undefined, 'text/markdown;q=0, */*', POST_REPRESENTATIONS)).toBe(true)
    expect(acceptPrefersHtml('text/markdown;q=0, application/json;q=0, */*')).toBe(true)
  })

  test('q-values rank the named representations', () => {
    expect(wantsJson(undefined, 'application/json;q=0.4, text/markdown;q=0.9')).toBe(false)
    expect(wantsMarkdown(undefined, 'application/json;q=0.4, text/markdown;q=0.9')).toBe(true)
    expect(acceptPrefersHtml('text/html;q=0.5, application/json')).toBe(false)
    // Equal preference keeps the old order: JSON first, so a plain browser never sees JSON.
    expect(wantsJson(undefined, 'application/json, text/markdown')).toBe(true)
    expect(acceptPrefersHtml('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')).toBe(true)
  })

  test('wildcards and missing headers name nothing, leaving the default and the preview-bot path', () => {
    for (const accept of ['', '*/*', 'text/*', 'image/png']) {
      expect(wantsJson(undefined, accept, POST_REPRESENTATIONS), accept).toBe(false)
      expect(wantsMarkdown(undefined, accept, POST_REPRESENTATIONS), accept).toBe(false)
      expect(acceptPrefersHtml(accept), accept).toBe(false)
    }
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
