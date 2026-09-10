import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import browseHandler from '../api/browse.js'
import notFoundHandler from '../api/notfound.js'
import { browse } from './browse.js'
import { resolveCaller } from './apiauth.js'
import { ConvertError } from './errors.js'
import {
  browseNotFoundDetail,
  defaultRepresentation,
  notFoundHtml,
  notFoundMarkdown,
  notFoundProblem,
  notFoundResponse,
  safePath,
} from './notfound.js'

vi.mock('./browse.js', async importOriginal => ({ ...await importOriginal<any>(), browse: vi.fn() }))
vi.mock('./apiauth.js', async importOriginal => ({ ...await importOriginal<any>(), resolveCaller: vi.fn() }))

function exchange(options: { method?: string; url?: string; accept?: string; query?: Record<string, string> } = {}) {
  const req = new IncomingMessage(new Socket()) as any
  req.method = options.method ?? 'GET'
  req.url = options.url ?? '/api/notfound'
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

const RECOVERY = ['https://x.pcstyle.dev/', '/docs', '/sitemap.xml', '/llms.txt', '/openapi.json']

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(resolveCaller).mockResolvedValue({ caller: { kind: 'public' }, status: 'anonymous', ip: '192.0.2.1' })
})

describe('recovery payloads', () => {
  test('the markdown body names the failing path, the recovery links, and the URL shapes', () => {
    const markdown = notFoundMarkdown('/nope')
    expect(markdown.startsWith('# 404 Not Found')).toBe(true)
    expect(markdown).toContain('/nope')
    for (const link of RECOVERY) expect(markdown).toContain(link)
    expect(markdown).toContain('`/{handle}/status/{id}`')
    expect(markdown).toContain('`/search?q={query}`')
  })

  test('the html body embeds the same markdown for a client that sent no Accept', () => {
    const html = notFoundHtml('/nope')
    expect(html).toContain('<pre>')
    expect(html).toContain('# 404 Not Found')
    expect(html).toContain('rel="alternate" type="text/markdown"')
    for (const link of RECOVERY) expect(html).toContain(link)
    // A caller-supplied path can never break out of the document.
    expect(notFoundHtml('/<script>alert(1)</script>')).not.toContain('<script>')
  })

  test('the json body is an RFC 9457 problem document with recovery links', () => {
    const problem = notFoundProblem('https://x.pcstyle.dev/nope', '/nope')
    expect(problem.status).toBe(404)
    expect(problem.code).toBe('route_not_found')
    expect(problem.detail).toContain('/nope')
    expect(problem.links?.map((link) => link.href)).toContain('https://x.pcstyle.dev/llms.txt')
  })

  test('a resource-aware detail replaces the provider\'s post-shaped message', () => {
    expect(browseNotFoundDetail('profile', 'zzqq', 'Post not found or unavailable.')).toContain('@zzqq')
    expect(browseNotFoundDetail('profile', 'zzqq')).not.toContain('Post')
    expect(browseNotFoundDetail('followers', 'zzqq')).toContain('followers')
    expect(browseNotFoundDetail('search', undefined)).toContain('search')
    // An unusable handle is never echoed back.
    expect(browseNotFoundDetail('profile', '<script>')).toContain('that account')
  })

  test('safePath rejects control characters and an uninterpolated rewrite token', () => {
    expect(safePath('/nope')).toBe('/nope')
    expect(safePath('nope')).toBe('/nope')
    expect(safePath(['api', 'v1', 'nope'])).toBe('/api/v1/nope')
    expect(safePath('/api/:path*')).toBeUndefined()
    expect(safePath(undefined)).toBeUndefined()
    expect(safePath('/a`b<c>')).toBe('/abc')
  })

  test('a caller with no preference gets markdown, or problem details under /api', () => {
    expect(defaultRepresentation('/api/v1/nope')).toBe('json')
    expect(defaultRepresentation('/nope.md')).toBe('markdown')
    expect(defaultRepresentation('/nope')).toBe('markdown')
    expect(defaultRepresentation()).toBe('markdown')
  })
})

describe('negotiated 404', () => {
  test.each([
    ['text/markdown', 'text/markdown'],
    ['text/html', 'text/html'],
    ['application/json', 'application/json'],
    ['*/*', 'text/markdown'],
    ['', 'text/markdown'],
    ['image/png', 'text/markdown'],
  ])('Accept %s stays 404 and answers %s', (accept, contentType) => {
    const response = notFoundResponse({ instance: 'https://x.pcstyle.dev/nope', accept, path: '/nope' })
    expect(response.status).toBe(404)
    expect(response.headers['Content-Type']).toContain(contentType)
    expect(response.headers.Vary).toBe('Accept')
    expect(response.headers.Link).toContain('</404.md>; rel="alternate"; type="text/markdown"')
    expect(response.body).toContain('llms.txt')
  })

  test('a caller with no preference on an /api path gets problem+json', () => {
    const response = notFoundResponse({ instance: 'https://x.pcstyle.dev/api/v1/nope', accept: '*/*', path: '/api/v1/nope' })
    expect(response.headers['Content-Type']).toContain('application/problem+json')
    expect(JSON.parse(response.body).code).toBe('route_not_found')
  })

  test('recovery links stay on the domain the request arrived on', () => {
    const instance = 'https://mdfromx.com/nope'
    for (const accept of ['text/markdown', 'text/html', 'application/json']) {
      const { body } = notFoundResponse({ instance, accept, path: '/nope' })
      expect(body).toContain('https://mdfromx.com/llms.txt')
      // The problem `type` stays a canonical identifier; only the recovery links move.
      if (accept !== 'application/json') expect(body).not.toContain('x.pcstyle.dev')
    }
    expect(notFoundProblem(instance, '/nope').links?.map((link) => link.href)).toContain('https://mdfromx.com/api')
  })
})

describe('the catch-all handler', () => {
  test.each(['text/markdown', 'text/html', 'application/json', '*/*', 'image/png'])(
    'answers 404 for Accept %s',
    async (accept) => {
      const { req, res } = exchange({ accept, url: '/api/notfound?path=/nope', query: { path: '/nope' } })
      await notFoundHandler(req, res)
      expect(res.statusCode).toBe(404)
      expect(res.body).toContain('llms.txt')
      expect(res.getHeader('Vary')).toBe('Accept')
    },
  )

  test('reports the original path, not its own', async () => {
    const { req, res } = exchange({ accept: 'application/json', url: '/api/notfound?path=/api/v1/nope', query: { path: '/api/v1/nope' } })
    await notFoundHandler(req, res)
    const problem = JSON.parse(res.body)
    expect(problem.instance).toBe('https://x.pcstyle.dev/api/v1/nope')
    expect(problem.detail).toContain('/api/v1/nope')
  })

  test('still answers 404 when the path parameter never arrives', async () => {
    const { req, res } = exchange({ accept: 'text/markdown' })
    await notFoundHandler(req, res)
    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('# 404 Not Found')
    expect(res.body).not.toContain('/api/notfound')
  })

  test('HEAD gets the status without a body', async () => {
    const { req, res } = exchange({ method: 'HEAD' })
    await notFoundHandler(req, res)
    expect(res.statusCode).toBe(404)
    expect(res.body).toBeUndefined()
  })
})

describe('browse misses', () => {
  test('an unknown handle answers 404 with a profile-shaped recovery document', async () => {
    vi.mocked(browse).mockRejectedValue(new ConvertError(404, 'Post not found or unavailable.', 'not_found'))
    const { req, res } = exchange({
      url: '/api/browse?resource=profile&handle=zzqqnouser42',
      query: { resource: 'profile', handle: 'zzqqnouser42' },
    })
    await browseHandler(req, res)
    expect(res.statusCode).toBe(404)
    expect(String(res.getHeader('Content-Type'))).toContain('text/markdown')
    expect(res.getHeader('Vary')).toBe('Accept')
    expect(res.body).toContain('@zzqqnouser42')
    expect(res.body).not.toContain('Post not found')
    expect(res.body).toContain('/sitemap.xml')
  })

  test('the same miss is problem+json for a JSON caller', async () => {
    vi.mocked(browse).mockRejectedValue(new ConvertError(404, 'Post not found or unavailable.', 'not_found'))
    const { req, res } = exchange({
      accept: 'application/json',
      url: '/api/browse?resource=followers&handle=zzqqnouser42',
      query: { resource: 'followers', handle: 'zzqqnouser42' },
    })
    await browseHandler(req, res)
    expect(res.statusCode).toBe(404)
    const problem = JSON.parse(res.body)
    expect(problem.code).toBe('not_found')
    expect(problem.detail).toContain('followers')
    expect(problem.links?.length).toBeGreaterThan(3)
  })
})
