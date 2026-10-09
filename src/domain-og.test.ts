import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import middleware from '../middleware'
import { domainText, domainFile } from '../lib/domain-pages'

const hosts = ['mdfromx.com', 'fast.mdfromx.com', 'www.elon-dont-c-and-d-me-plz.dev', 'future-domain.example']

describe('host-aware pages and social cards', () => {
  test('leaves unrelated hostnames intact and handles sentence punctuation', () => {
    const source = 'https://notmdfromx.com/path https://x.pcstyle.dev.evil.example https://other.mdfromx.com/path mdfromx.com.'
    expect(domainText(source, 'https://future.example')).toBe(
      'https://notmdfromx.com/path https://x.pcstyle.dev.evil.example https://other.mdfromx.com/path future.example.',
    )
  })
  test.each(hosts)('uses %s throughout raw HTML metadata and copy', (host) => {
    const original = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
    const result = domainText(original, `https://${host}`)
    expect(result).toContain(`property="og:image" content="https://${host}/og.png"`)
    expect(result).toContain(`name="twitter:image" content="https://${host}/og.png"`)
    expect(result).toContain(`rel="canonical" href="https://${host}/"`)
    expect(result).not.toContain('x.pcstyle.dev')
  })

  test.each(hosts)('routes %s docs, discovery and images through the host renderer', (host) => {
    const response = (path: string, accept = 'text/html') => middleware(new Request(`https://${host}${path}`, { headers: { Accept: accept } }))
    for (const path of ['/', '/docs', '/docs/posts', '/openapi.json', '/og.png', '/og/docs/posts.png', '/feeds/x-md.jsonl',
      '/.well-known/integrations.json', '/.well-known/agent-card.json']) {
      const target = new URL(response(path).headers.get('x-middleware-rewrite')!)
      expect(target.pathname).toBe('/api/site')
      expect(target.searchParams.get('path')).toBe(path)
    }
    for (const [path, accept, expected] of [['/docs/posts', 'text/markdown', '/docs/posts.md'], ['/?mode=agent', 'text/html', '/index.md']]) {
      expect(new URL(response(path!, accept!).headers.get('x-middleware-rewrite')!).searchParams.get('path')).toBe(expected)
    }
    expect(response('/', 'image/png').status).toBe(406)
    for (const path of ['/jack/status/20', '/api/v1/posts', '/assets/main.js', '/_astro/main.js']) {
      expect(response(path).headers.get('x-middleware-rewrite')).toBeNull()
    }
  })

  test.each(hosts)('declares %s, not the default host, in integrations.json and the agent card', (host) => {
    const read = (file: string) => JSON.parse(domainText(readFileSync(new URL(`../public/.well-known/${file}`, import.meta.url), 'utf8'), `https://${host}`))
    const integrations = read('integrations.json')
    expect(JSON.stringify(integrations)).not.toContain('x.pcstyle.dev')
    for (const surface of integrations.surfaces) {
      expect(surface.basis.source).toBe(`https://${host}/.well-known/integrations.json`)
      expect(new URL(surface.url).host).toBe(host)
    }
    const card = read('agent-card.json')
    expect(JSON.stringify(card)).not.toContain('x.pcstyle.dev')
    expect(card.url).toBe(`https://${host}/mcp`)
  })

  test('maps only safe public files', () => {
    expect(domainFile('/docs/posts/')).toBe('docs/posts/index.html')
    expect(domainFile('/api/docs/pages/docs/posts.json')).toBe('api/docs/pages/docs/posts.json')
    expect(domainFile('/docs/llms.txt')).toBe('docs/llms.txt')
    expect(domainFile('/.well-known/agent-skills/browse-x.md')).toBe('.well-known/agent-skills/browse-x.md')
    for (const path of ['/docs/../../.env', '/docs/%2e%2e/index.html', '/docs/..\\secret', '/_domains/mdfromx/index.html', '/api/site']) {
      expect(domainFile(path)).toBeNull()
    }
  })
})
