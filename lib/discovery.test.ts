import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

/**
 * The static discovery surface — catalogs, robots, sitemap, and the Markdown
 * twins — is only ever validated by the crawlers that read it in production, so
 * a typo here fails silently. These assertions are the missing feedback loop.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(`../public/${path}`, import.meta.url)), 'utf8')
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>

const SITE = 'https://x.pcstyle.dev'
const PUBLISHER = 'x.pcstyle.dev'
const URN_AIR = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/
const MARKDOWN_DOCS = ['index.md', 'about.md', 'contact.md', 'privacy.md', 'terms.md', 'agents.md', 'auth.md', 'pricing.md']

/**
 * Every page blume builds from `docs/`. The sitemap and the two llms.txt
 * indexes are hand-written, so a new docs page is invisible to agents until it
 * is listed; deriving the expectation from the source is the only way that
 * omission fails loudly.
 */
const DOCS_SLUGS = ['docs', 'docs/(api)']
  .flatMap((dir) => readdirSync(fileURLToPath(new URL(`../${dir}`, import.meta.url))))
  .filter((name) => name.endsWith('.mdx'))
  .map((name) => name.replace(/\.mdx$/, ''))
  .filter((slug) => slug !== 'index')

interface ArdEntry {
  identifier: string
  displayName: string
  type: string
  url?: string
  data?: unknown
  trustManifest?: { identity?: string; trustSchema?: unknown; attestations?: unknown[] }
}

describe('ARD catalog', () => {
  const catalog = json('.well-known/ard.json') as unknown as { specVersion: string; host: { displayName: string; identifier: string }; entries: ArdEntry[] }

  test('is a v1.0 catalog with a host and entries', () => {
    expect(catalog.specVersion).toBe('1.0')
    expect(catalog.host.displayName).toBe('x.md')
    expect(catalog.entries.length).toBeGreaterThan(0)
  })

  test('publishes the MCP server, the REST API, the skill index, and the llms.txt documents', () => {
    const urls = catalog.entries.map((entry) => entry.url)
    expect(urls).toContain(`${SITE}/.well-known/mcp/server-card.json`)
    expect(urls).toContain(`${SITE}/openapi.json`)
    expect(urls).toContain(`${SITE}/.well-known/agent-skills/index.json`)
    expect(urls).toContain(`${SITE}/llms.txt`)
    expect(urls).toContain(`${SITE}/llms-full.txt`)
  })

  test.each([['ard.json'], ['ai-catalog.json']])('%s entries carry a urn:air id, a name, a media type, and exactly one target', (file) => {
    const entries = (json(`.well-known/${file}`) as unknown as { entries: ArdEntry[] }).entries
    for (const entry of entries) {
      expect(entry.identifier).toMatch(URN_AIR)
      // Publisher-authority binding: the URN's publisher segment is this domain.
      expect(entry.identifier.split(':')[2]).toBe(PUBLISHER)
      expect(entry.displayName.length).toBeGreaterThan(0)
      expect(entry.type).toMatch(/^[a-z]+\/[\w.+-]+$/)
      expect('url' in entry).not.toBe('data' in entry)
    }
  })

  test('every entry carries a trust manifest whose identity is the publisher domain', () => {
    for (const entry of catalog.entries) {
      expect(entry.trustManifest?.identity).toBe(SITE)
      expect(entry.trustManifest?.trustSchema).toBeDefined()
      expect(entry.trustManifest?.attestations?.length).toBeGreaterThan(0)
    }
  })

  test('the legacy ai-catalog.json alias serves the same document', () => {
    expect(read('.well-known/ai-catalog.json')).toBe(read('.well-known/ard.json'))
  })
})

describe('RFC 9727 API catalog', () => {
  const linkset = (json('.well-known/api-catalog') as unknown as {
    linkset: { anchor: string; item?: { href: string }[]; 'service-desc'?: { href: string; type: string }[] }[]
  }).linkset

  test('anchors the catalog at its own well-known URI with item entries', () => {
    expect(linkset[0]?.anchor).toBe(`${SITE}/.well-known/api-catalog`)
    expect(linkset[0]?.item?.length).toBeGreaterThan(0)
    for (const item of linkset[0]?.item ?? []) expect(new URL(item.href).origin).toBe(new URL(SITE).origin)
  })

  test('every item has its own anchored entry with a service description', () => {
    for (const item of linkset[0]?.item ?? []) {
      const entry = linkset.find((link) => link.anchor === item.href)
      expect(entry, `no linkset entry anchored at ${item.href}`).toBeDefined()
      expect(entry?.['service-desc']?.length).toBeGreaterThan(0)
    }
  })

  test('describes the REST API with the OpenAPI media type', () => {
    const api = linkset.find((link) => link.anchor === `${SITE}/api`)
    expect(api?.['service-desc']).toContainEqual({ href: `${SITE}/openapi.json`, type: 'application/vnd.oai.openapi+json' })
  })
})

describe('served markdown', () => {
  test.each(MARKDOWN_DOCS)('%s opens with frontmatter carrying title, description, canonical, and last-updated', (file) => {
    const source = read(file)
    expect(source.startsWith('---\n')).toBe(true)
    const frontmatter = source.slice(4, source.indexOf('\n---\n', 3))
    for (const key of ['title', 'description', 'canonical', 'last-updated']) {
      expect(frontmatter).toMatch(new RegExp(`^${key}:\\s*\\S`, 'm'))
    }
    // The heading has to survive the frontmatter block: auth.md is graded on it.
    expect(source).toMatch(/^# \S/m)
  })

  test('auth.md walks the WorkOS sections and says authentication is not required', () => {
    const source = read('auth.md')
    for (const heading of ['## Discover', '## Pick a method', '## Register', '## Claim', '## Exchange', '## Use the access_token', '## Errors', '## Revocation']) {
      expect(source).toContain(heading)
    }
    for (const anchor of ['agent_auth', 'identity_endpoint', 'identity_assertion', 'service_auth', 'id-jag', 'WWW-Authenticate']) {
      expect(source).toContain(anchor)
    }
    expect(source).toContain('No authentication is required')
  })

  test('pricing.md states the free price and the limits that stand in for cost', () => {
    const source = read('pricing.md')
    expect(source).toMatch(/^## Plans$/m)
    expect(source).toContain('$0')
    expect(source).toMatch(/429/)
  })
})

describe('llms.txt', () => {
  const root = read('llms.txt')

  test('answers when to use x.md and when not to', () => {
    expect(root).toContain('## When to use x.md')
    expect(root).toContain('## When not to use x.md')
    expect(root).toContain('## Agent resources')
  })

  test('points agents at every machine surface', () => {
    for (const target of ['/openapi.json', '/mcp', '/.well-known/ard.json', '/llms-full.txt', '/.well-known/agent-skills/index.json']) {
      expect(root).toContain(`${SITE}${target}`)
    }
  })

  test('the docs section publishes its own scoped index', () => {
    const docs = read('docs/llms.txt')
    expect(docs.startsWith('# x.md documentation')).toBe(true)
    expect(docs).toContain(`${SITE}/docs/posts.md`)
  })

  test.each(DOCS_SLUGS)('/docs/%s is listed in both the root index and the scoped one', (slug) => {
    expect(root).toContain(`${SITE}/docs/${slug})`)
    expect(read('docs/llms.txt')).toContain(`${SITE}/docs/${slug}.md)`)
  })
})

/**
 * The inverse of the DOCS_SLUGS listings above: a page retired from `docs/`
 * (moved to internal/, say) must also leave every hand-written index, or
 * agents keep following a link into a 404.
 */
describe('retired docs pages', () => {
  test.each(['sitemap.xml', 'llms.txt', 'docs/llms.txt', 'feeds/x-md.jsonl'])('%s only links to pages that still exist under docs/', (path) => {
    const linked = [...read(path).matchAll(/x\.pcstyle\.dev\/docs\/([a-z0-9-]+)/g)].map((match) => match[1]).filter((slug) => slug !== 'llms')
    for (const slug of linked) {
      expect(DOCS_SLUGS, `${path} still links /docs/${slug}`).toContain(slug)
    }
  })
})

describe('NLWeb schema feeds', () => {
  const map = read('schemamap.xml')

  test('robots.txt points at a schema map that lists a real feed', () => {
    expect(map).toContain('xmlns:sf="http://schema.org/schemas/schemafeed/0.1"')
    const loc = map.match(/<loc>([^<]+)<\/loc>/)?.[1]
    expect(loc).toBe(`${SITE}/feeds/x-md.jsonl`)
    expect(map).toContain('<sf:contentType>structuredData/schema.org</sf:contentType>')
  })

  test('every feed line is one parseable schema.org node', () => {
    const lines = read('feeds/x-md.jsonl').split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(2)
    for (const line of lines) {
      const node = JSON.parse(line) as { '@context': string; '@type': string; '@id': string }
      expect(node['@context']).toBe('https://schema.org')
      expect(node['@type'].length).toBeGreaterThan(0)
      expect(new URL(node['@id']).origin).toBe(new URL(SITE).origin)
    }
  })

  test('the feed covers every docs page', () => {
    const feed = read('feeds/x-md.jsonl')
    for (const slug of DOCS_SLUGS) expect(feed).toContain(`"${SITE}/docs/${slug}"`)
  })
})

describe('robots.txt', () => {
  const robots = read('robots.txt')
  const directives = robots.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))

  test('never hides the documented JSON API', () => {
    const disallowed = directives.filter((line) => /^disallow:/i.test(line)).map((line) => line.split(':')[1]!.trim())
    for (const path of ['/api/v1/', '/api/convert', '/api/browse', '/api/oembed', '/mcp']) {
      expect(disallowed.some((rule) => rule !== '/' && path.startsWith(rule))).toBe(false)
    }
    expect(disallowed).toContain('/api/admin')
  })

  test('tiers AI crawlers instead of leaving one open default', () => {
    for (const agent of ['GPTBot', 'OAI-SearchBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'Applebot-Extended']) {
      expect(directives).toContain(`User-agent: ${agent}`)
    }
    // Training-corpus crawlers are refused deliberately, each in its own group.
    for (const agent of ['CCBot', 'Bytespider']) {
      const group = robots.slice(robots.indexOf(`User-agent: ${agent}`))
      expect(group.slice(0, group.indexOf('\n\n'))).toContain('Disallow: /')
    }
    expect(robots).toMatch(/^Content-Signal: search=yes, ai-input=yes, ai-train=no$/m)
  })

  test('advertises the sitemap and the NLWeb schema map', () => {
    expect(directives).toContain(`Sitemap: ${SITE}/sitemap.xml`)
    expect(directives).toContain(`schemamap: ${SITE}/schemamap.xml`)
  })
})

describe('sitemap.xml', () => {
  const sitemap = read('sitemap.xml')
  const blocks = sitemap.match(/<url>[\s\S]*?<\/url>/g) ?? []

  test('is a well-formed urlset', () => {
    expect(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(sitemap.trimEnd().endsWith('</urlset>')).toBe(true)
    // Every opening tag has a matching close, so nothing is silently truncated.
    for (const tag of ['url', 'loc', 'lastmod']) {
      expect(sitemap.match(new RegExp(`<${tag}>`, 'g'))?.length).toBe(sitemap.match(new RegExp(`</${tag}>`, 'g'))?.length)
    }
    expect(blocks.length).toBe(sitemap.match(/<loc>/g)?.length)
  })

  test('dates every entry so agents can tell what changed', () => {
    expect(blocks.length).toBeGreaterThan(10)
    for (const block of blocks) {
      expect(block).toMatch(/<loc>https:\/\/x\.pcstyle\.dev\/[^<]*<\/loc>/)
      const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]
      expect(lastmod, `missing lastmod in ${block}`).toBeDefined()
      expect(lastmod).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(lastmod!))).toBe(false)
    }
  })

  test('lists the pages that only exist for agents and humans arriving from search', () => {
    for (const path of ['/about', '/contact', '/privacy', '/terms', '/mcp', '/auth.md', '/pricing.md']) {
      expect(sitemap).toContain(`<loc>${SITE}${path}</loc>`)
    }
  })

  test.each(DOCS_SLUGS)('/docs/%s is listed', (slug) => {
    expect(sitemap).toContain(`<loc>${SITE}/docs/${slug}</loc>`)
  })
})

describe('security.txt', () => {
  const security = read('.well-known/security.txt')

  test('carries an unexpired RFC 9116 contact', () => {
    expect(security).toMatch(/^Contact: https:\/\/github\.com\/pc-style\/x-md\/security\/advisories\/new$/m)
    expect(security).toMatch(/^Canonical: https:\/\/x\.pcstyle\.dev\/\.well-known\/security\.txt$/m)
    expect(security).toMatch(/^Policy: https:/m)
    expect(security).toMatch(/^Preferred-Languages: en$/m)
    const expires = security.match(/^Expires: (.+)$/m)?.[1]
    expect(expires).toBeDefined()
    // RFC 9116 caps the useful lifetime at a year; an expired file is ignored.
    // Measured against the real clock so the renewal reminder is this test
    // failing, not a scanner quietly dropping the security contact.
    const remaining = Date.parse(expires!) - Date.parse('2026-09-08T00:00:00Z')
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(365 * 24 * 3600 * 1000)
    expect(Date.parse(expires!)).toBeGreaterThan(Date.now())
  })
})
