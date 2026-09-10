import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import middleware from '../middleware'
import { domainText, domainFile } from '../lib/domain-pages'

describe('domain-specific social cards', () => {
  test('updates domain references in metadata and copy, preserving other wording', () => {
    const original = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const result = domainText(original)
    expect(result).toContain('property="og:image" content="https://mdfromx.com/og/mdfromx-v1.png"')
    expect(result).toContain('name="twitter:image" content="https://mdfromx.com/og/mdfromx-v1.png"')
    expect(result).toContain('property="og:url" content="https://mdfromx.com/"')
    expect(result).toContain('rel="canonical" href="https://mdfromx.com/"')
    expect(result).not.toContain('x.pcstyle.dev')
    expect(result.split('<body')[1]).toBe(original.split('<body')[1]?.replaceAll('x.pcstyle.dev', 'mdfromx.com'))
  })

  test('only rewrites HTML on the new domain, preserving Markdown and 406 responses', () => {
    const response = (host: string, path = '/', accept = 'text/html') =>
      middleware(new Request(`https://${host}${path}`, { headers: { Accept: accept } }))
    expect(response('mdfromx.com').headers.get('x-middleware-rewrite')).toBe('https://mdfromx.com/_domains/mdfromx/index.html')
    expect(response('x.pcstyle.dev').headers.get('x-middleware-rewrite')).toBeNull()
    expect(response('mdfromx.com', '/', 'text/markdown').headers.get('x-middleware-rewrite')).toBe('https://mdfromx.com/_domains/mdfromx/index.md')
    expect(response('mdfromx.com', '/?mode=agent').headers.get('x-middleware-rewrite')).toBe('https://mdfromx.com/_domains/mdfromx/index.md')
    expect(response('mdfromx.com', '/', 'image/png').status).toBe(406)
    expect(response('mdfromx.com', '/docs').headers.get('x-middleware-rewrite')).toBe('https://mdfromx.com/_domains/mdfromx/docs/index.html')
    expect(response('mdfromx.com', '/docs/posts', 'text/markdown').headers.get('x-middleware-rewrite')).toBe('https://mdfromx.com/_domains/mdfromx/docs/posts.md')
    expect(response('mdfromx.com', '/jack/status/20').headers.get('x-middleware-rewrite')).toBeNull()
    expect(response('mdfromx.com', '/api/v1/posts').headers.get('x-middleware-rewrite')).toBeNull()
    expect(response('mdfromx.com', '/assets/main.js').headers.get('x-middleware-rewrite')).toBeNull()
  })

  test('maps docs, discovery, and OG paths to their built files', () => {
    expect(domainFile('/docs/posts/')).toBe('docs/posts/index.html')
    expect(domainFile('/api/docs/pages/docs/posts.json')).toBe('api/docs/pages/docs/posts.json')
    expect(domainFile('/docs/llms.txt')).toBe('docs/llms.txt')
    expect(domainFile('/blume-search.json')).toBe('blume-search.json')
    expect(domainFile('/og/docs/posts.png')).toBe('og/docs/posts.png')
    expect(domainFile('/og.png')).toBe('og.png')
    expect(domainFile('/.well-known/api-catalog')).toBe('.well-known/api-catalog')
    expect(domainFile('/_domains/mdfromx/index.html')).toBeNull()
  })
})
