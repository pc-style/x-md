import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, test } from 'vitest'
import browseHandler from '../api/browse.js'
import convertHandler from '../api/convert.js'
import indexHandler from '../api/index.js'
import {
  ERROR_CATALOG,
  LEGACY_DEPRECATION,
  LEGACY_SUNSET,
  appendLink,
  problemDetails,
  problemFrom,
  problemMediaType,
  problemResponse,
  sendProblem,
  setDeprecationHeaders,
} from './apierror.js'
import { ConvertError } from './errors.js'

function exchange(options: { method?: string; url?: string; accept?: string; query?: Record<string, string> } = {}) {
  const req = new IncomingMessage(new Socket()) as any
  req.method = options.method ?? 'GET'
  req.url = options.url ?? '/api/convert'
  req.query = options.query ?? {}
  req.headers = { host: 'x.pcstyle.dev', 'x-forwarded-proto': 'https', accept: options.accept ?? '*/*' }
  const res = new ServerResponse(req) as any
  res.body = undefined
  res.status = (code: number) => { res.statusCode = code; return res }
  res.send = (body: string) => { res.body = body; return res }
  res.json = (payload: unknown) => { res.body = JSON.stringify(payload); return res }
  res.end = (body?: string) => { if (body !== undefined) res.body = body; return res }
  return { req, res }
}

describe('problem documents', () => {
  test('every catalog entry has a title and an actionable resolution', () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.title.length, code).toBeGreaterThan(3)
      expect(entry.resolution.length, code).toBeGreaterThan(20)
      expect(entry.status, code).toBeGreaterThanOrEqual(400)
    }
  })

  test('a ConvertError becomes a complete problem document', () => {
    const problem = problemFrom(
      new ConvertError(400, 'Invalid URL. Provide a public X/Twitter status URL.', 'invalid_url'),
      'https://x.pcstyle.dev/api/convert?url=notaurl',
    )
    expect(problem).toMatchObject({
      type: 'https://x.pcstyle.dev/docs/reliability#invalid-url',
      title: 'Invalid X status URL',
      status: 400,
      detail: 'Invalid URL. Provide a public X/Twitter status URL.',
      instance: 'https://x.pcstyle.dev/api/convert?url=notaurl',
      code: 'invalid_url',
      documentation_url: 'https://x.pcstyle.dev/docs/reliability#errors',
    })
    expect(problem.resolution).toContain('x.com')
    // The pre-9457 field stays in sync so existing clients keep working.
    expect(problem.error).toBe(problem.detail)
  })

  test('429 and 503 carry retry_after and a Retry-After header', () => {
    const limited = problemFrom(new ConvertError(429, 'Too many searches.', 'rate_limited', 42), 'https://x.pcstyle.dev/search?q=a')
    const response = problemResponse(limited, '*/*')
    expect(response.status).toBe(429)
    expect(limited.retry_after).toBe(42)
    expect(response.headers['Retry-After']).toBe('42')
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(problemFrom(new ConvertError(429, 'slow down', 'rate_limited'), 'https://x.pcstyle.dev/search').retry_after).toBe(60)
    expect(problemFrom(new ConvertError(503, 'no sessions', 'search_unavailable'), 'https://x.pcstyle.dev/search').retry_after).toBe(30)
  })

  test('a provider code outside the catalogue is described by its status class', () => {
    // lib/fxtwitter.ts and the fallback providers raise codes the published
    // catalogue does not name; openapi.json promises they read as their class.
    const priv = problemFrom(new ConvertError(404, 'Post is private and cannot be fetched.', 'private_tweet'), 'https://x.pcstyle.dev/jack/status/20')
    expect(priv.status).toBe(404)
    expect(priv.code).toBe('private_tweet')
    expect(priv.title).toBe(ERROR_CATALOG.not_found.title)
    expect(priv.resolution).toBe(ERROR_CATALOG.not_found.resolution)
    expect(priv.type).toBe('https://x.pcstyle.dev/docs/reliability#not-found')

    const upstream = problemFrom(new ConvertError(502, 'All fetch providers failed.', 'all_providers_failed'), 'https://x.pcstyle.dev/jack/status/20')
    expect(upstream.title).toBe(ERROR_CATALOG.upstream_error.title)
    expect(upstream.resolution).toBe(ERROR_CATALOG.upstream_error.resolution)

    // A catalogued code still describes itself.
    expect(problemFrom(new ConvertError(404, 'gone', 'not_found'), 'https://x.pcstyle.dev/x').title).toBe(ERROR_CATALOG.not_found.title)
  })

  test('an unknown throwable never leaks internals', () => {
    const problem = problemFrom(new TypeError('fetch failed at 10.0.0.1'), 'https://x.pcstyle.dev/api/browse')
    expect(problem.status).toBe(500)
    expect(problem.code).toBe('internal_error')
    expect(JSON.stringify(problem)).not.toContain('10.0.0.1')
  })

  test.each([
    ['*/*', 'application/problem+json'],
    ['', 'application/problem+json'],
    ['text/markdown', 'application/problem+json'],
    ['application/json', 'application/json'],
    ['application/problem+json', 'application/problem+json'],
  ])('Accept %s selects %s', (accept, expected) => {
    expect(problemMediaType(accept)).toBe(expected)
  })

  test('the body is JSON and the response varies on Accept', () => {
    const { headers, body } = problemResponse(
      problemDetails('route_not_found', { instance: 'https://x.pcstyle.dev/api/v1/anything' }),
      '*/*',
    )
    expect(headers.Vary).toBe('Accept')
    expect(headers.Link).toContain('rel="service-desc"')
    expect(JSON.parse(body).code).toBe('route_not_found')
  })
})

describe('deprecation signalling', () => {
  test('emits an RFC 9745 date, an RFC 8594 HTTP-date, and a successor link', () => {
    const { res } = exchange()
    setDeprecationHeaders(res, '/api/v1/posts')
    expect(res.getHeader('Deprecation')).toMatch(/^@\d{10}$/)
    expect(res.getHeader('Sunset')).toBe(LEGACY_SUNSET)
    expect(Date.parse(String(res.getHeader('Sunset')))).toBeGreaterThan(Number(LEGACY_DEPRECATION.slice(1)) * 1000)
    expect(res.getHeader('Link')).toContain('<https://x.pcstyle.dev/api/v1/posts>; rel="successor-version"')
    expect(res.getHeader('Link')).toContain('rel="deprecation"')
  })

  test('appendLink keeps links already on the response', () => {
    const { res } = exchange()
    res.setHeader('Link', '</docs>; rel="service-doc"')
    appendLink(res, '</openapi.json>; rel="service-desc"')
    expect(res.getHeader('Link')).toBe('</docs>; rel="service-doc", </openapi.json>; rel="service-desc"')
  })
})

describe('handlers answer with problem details', () => {
  test('a write method is refused as problem+json with an Allow header', async () => {
    const { req, res } = exchange({ method: 'POST' })
    await convertHandler(req, res)
    expect(res.statusCode).toBe(405)
    expect(res.getHeader('Allow')).toBe('GET, HEAD, OPTIONS')
    expect(String(res.getHeader('Content-Type'))).toContain('application/problem+json')
    const problem = JSON.parse(res.body)
    expect(problem.code).toBe('method_not_allowed')
    expect(problem.resolution).toContain('GET')
  })

  test('a validation failure is problem+json and keeps the legacy fields', async () => {
    const { req, res } = exchange({ url: '/api/convert?url=notaurl', query: { url: 'notaurl' } })
    await convertHandler(req, res)
    expect(res.statusCode).toBe(400)
    const problem = JSON.parse(res.body)
    expect(problem.code).toBe('invalid_url')
    expect(problem.error).toBe(problem.detail)
    expect(problem.instance).toBe('https://x.pcstyle.dev/api/convert?url=notaurl')
  })

  test('the deprecated alias is signalled but the permalink route is not', async () => {
    const alias = exchange({ url: '/api/convert?url=notaurl', query: { url: 'notaurl' } })
    await convertHandler(alias.req, alias.res)
    expect(alias.res.getHeader('Deprecation')).toBe(LEGACY_DEPRECATION)
    expect(alias.res.getHeader('Link')).toContain('rel="successor-version"')

    const permalink = exchange({ url: '/api/convert?handle=jack&id=20', query: { handle: 'jack', id: '20' } })
    await convertHandler(permalink.req, permalink.res)
    expect(permalink.res.getHeader('Deprecation')).toBeUndefined()

    const versioned = exchange({ url: '/api/convert?via=route&url=notaurl', query: { via: 'route', url: 'notaurl' } })
    await convertHandler(versioned.req, versioned.res)
    expect(versioned.res.getHeader('Deprecation')).toBeUndefined()
  })

  test('a direct /api/browse call is signalled deprecated, a rewritten one is not', async () => {
    // POST stops at the method guard, so neither call reaches the browse layer.
    const direct = exchange({
      method: 'POST',
      url: '/api/browse?resource=profile&handle=jack',
      query: { resource: 'profile', handle: 'jack' },
    })
    await browseHandler(direct.req, direct.res)
    expect(direct.res.getHeader('Deprecation')).toBe(LEGACY_DEPRECATION)
    expect(direct.res.getHeader('Sunset')).toBe(LEGACY_SUNSET)
    expect(direct.res.getHeader('Link')).toContain('<https://x.pcstyle.dev/api/v1/profiles/jack>; rel="successor-version"')

    const routed = exchange({
      method: 'POST',
      url: '/api/browse?resource=profile&handle=jack&via=route',
      query: { resource: 'profile', handle: 'jack', via: 'route' },
    })
    await browseHandler(routed.req, routed.res)
    expect(routed.res.getHeader('Deprecation')).toBeUndefined()
  })

  test('a successor link is omitted rather than emitted as a URI template', async () => {
    const { req, res } = exchange({ method: 'POST', url: '/api/browse' })
    await browseHandler(req, res)
    expect(res.getHeader('Deprecation')).toBe(LEGACY_DEPRECATION)
    expect(String(res.getHeader('Link'))).not.toContain('{handle}')
    expect(String(res.getHeader('Link'))).not.toContain('successor-version')
  })

  test('/api is a JSON index of every operation and error code', async () => {
    const { req, res } = exchange({ url: '/api' })
    await indexHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(String(res.getHeader('Content-Type'))).toContain('application/json')
    expect(res.getHeader('Vary')).toBe('Accept')
    const index = JSON.parse(res.body)
    expect(index.name).toBe('x.md')
    expect(index.openapi_url).toBe('https://x.pcstyle.dev/openapi.json')
    expect(index.links.mcp).toBe('https://x.pcstyle.dev/mcp')
    expect(index.endpoints.map((endpoint: { path: string }) => endpoint.path)).toContain('/api/v1/posts')
    expect(index.endpoints.every((endpoint: { description: string }) => endpoint.description.length > 20)).toBe(true)
    expect(index.errors.codes).toHaveLength(Object.keys(ERROR_CATALOG).length)
    expect(index.versioning.deprecated_aliases[0].sunset).toBe(LEGACY_SUNSET)
  })

  test('/api serves markdown when asked for it', async () => {
    const { req, res } = exchange({ url: '/api', accept: 'text/markdown' })
    await indexHandler(req, res)
    expect(res.statusCode).toBe(200)
    expect(String(res.getHeader('Content-Type'))).toContain('text/markdown')
    expect(res.body).toContain('# x.md API index')
    expect(res.body).toContain('/api/v1/posts')
  })

  test('/api refuses writes with problem details', async () => {
    const { req, res } = exchange({ url: '/api', method: 'DELETE' })
    await indexHandler(req, res)
    expect(res.statusCode).toBe(405)
    expect(JSON.parse(res.body).code).toBe('method_not_allowed')
  })

  test('sendProblem writes no body for HEAD', () => {
    const { res } = exchange({ method: 'HEAD' })
    sendProblem(res, problemDetails('not_found', { instance: 'https://x.pcstyle.dev/api/convert' }), '*/*', 'HEAD')
    expect(res.statusCode).toBe(404)
    expect(res.body).toBeUndefined()
  })
})
