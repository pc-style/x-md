import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { FAQ, landingHtml } from './landing'
import { pageBuilders, type PageSlug } from './pages'
import { prerenderLandingPlugin } from './vite-prerender-plugin'

const root = (file: string) => fileURLToPath(new URL(`../${file}`, import.meta.url))
const read = (file: string) => readFileSync(root(file), 'utf8')

const indexHtml = read('index.html')

interface Node {
  '@id'?: string
  '@type': string | string[]
  [key: string]: unknown
}

function graphOf(html: string): Node[] {
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)
  expect(block, 'page has a JSON-LD block').toBeTruthy()
  const parsed = JSON.parse(block![1]) as { '@graph': Node[] }
  return parsed['@graph']
}

const hasType = (node: Node, type: string) =>
  Array.isArray(node['@type']) ? node['@type'].includes(type) : node['@type'] === type

const nodeOf = (graph: Node[], type: string) => {
  const node = graph.find((entry) => hasType(entry, type))
  expect(node, `@graph contains a ${type} node`).toBeTruthy()
  return node!
}

/** Every `{"@id": …}` reference in the document, wherever it is nested. */
function references(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) references(item, found)
    return found
  }
  if (!value || typeof value !== 'object') return found
  const entries = Object.entries(value as Record<string, unknown>)
  const id = (value as Record<string, unknown>)['@id']
  if (entries.length === 1 && typeof id === 'string') found.push(id)
  for (const [, child] of entries) references(child, found)
  return found
}

/** Rendered text, the way a crawler that does not run JavaScript sees it. */
function textOf(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;|&ndash;/g, '-')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

const landing = landingHtml()
const SLUGS: PageSlug[] = ['about', 'contact', 'privacy', 'terms']

describe('homepage JSON-LD', () => {
  const graph = graphOf(indexHtml)

  test('Organization carries contactPoint, address, and sameAs', () => {
    const org = nodeOf(graph, 'Organization')
    expect(org.alternateName).toBeTruthy()

    const contacts = org.contactPoint as { '@type': string; contactType?: string; url?: string }[]
    expect(Array.isArray(contacts)).toBe(true)
    expect(contacts.length).toBeGreaterThan(0)
    for (const contact of contacts) {
      expect(contact['@type']).toBe('ContactPoint')
      expect(contact.contactType).toBeTruthy()
      expect(contact.url).toMatch(/^https:\/\//)
    }

    const address = org.address as { '@type': string; addressCountry?: string }
    expect(address['@type']).toBe('PostalAddress')
    expect(address.addressCountry).toMatch(/^[A-Z]{2}$/)

    const sameAs = org.sameAs as string[]
    expect(sameAs.length).toBeGreaterThanOrEqual(3)
    for (const url of sameAs) expect(url).toMatch(/^https:\/\//)
    expect(sameAs).toContain('https://github.com/pc-style/x-md')
  })

  test('FAQPage repeats the questions the page actually renders', () => {
    const faq = nodeOf(graph, 'FAQPage')
    const questions = faq.mainEntity as {
      '@type': string
      name: string
      acceptedAnswer: { '@type': string; text: string }
    }[]
    expect(questions.length).toBeGreaterThanOrEqual(4)
    expect(questions.length).toBe(FAQ.length)

    const text = textOf(landing)
    for (const [index, question] of questions.entries()) {
      expect(question['@type']).toBe('Question')
      expect(question.acceptedAnswer['@type']).toBe('Answer')
      expect(question.name).toBe(FAQ[index].question)
      expect(question.acceptedAnswer.text).toBe(FAQ[index].answer)
      // Structured data may only describe content the page shows.
      expect(text).toContain(question.name)
      expect(text).toContain(question.acceptedAnswer.text)
    }
  })

  test('reaches beyond WebSite and Organization', () => {
    const types = graph.flatMap((node) => (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]))
    for (const type of ['WebSite', 'Organization', 'SoftwareApplication', 'FAQPage', 'BreadcrumbList', 'WebAPI', 'Service', 'Person']) {
      expect(types).toContain(type)
    }
  })

  test('the read-only API node points at the published descriptions', () => {
    const api = nodeOf(graph, 'WebAPI')
    expect(api.documentation).toEqual(
      expect.arrayContaining(['https://x.pcstyle.dev/docs', 'https://x.pcstyle.dev/openapi.json']),
    )
    expect(api.termsOfService).toBe('https://x.pcstyle.dev/terms')
  })

  test('every @id reference resolves inside the graph', () => {
    const ids = new Set(graph.map((node) => node['@id']).filter(Boolean))
    for (const reference of references(graph)) expect(ids).toContain(reference)
  })
})

/** The prerender transform, exactly as Vite calls it at build time. */
function prerender(html: string): string {
  const transform = prerenderLandingPlugin().transformIndexHtml
  const handler = typeof transform === 'function' ? transform : transform!.handler
  return handler.call(null as never, html, null as never) as string
}

describe('the homepage reads without JavaScript', () => {
  const rendered = prerender(indexHtml)

  // A stray edit to the `#app` shell would silently drop the transform and take
  // the homepage back to 34 characters of raw text.
  test('the mount node is filled in, not left as a client-rendered shell', () => {
    expect(indexHtml).toContain('<div id="app"></div>')
    expect(rendered).not.toContain('<div id="app"></div>')
  })

  test('serves far more than the 500 characters crawlers look for', () => {
    const body = rendered.slice(rendered.indexOf('<body>'))
    expect(textOf(body).length).toBeGreaterThanOrEqual(3000)
  })

  test('opens with a single h1 and no skipped heading level', () => {
    const levels = [...rendered.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]))
    expect(levels.filter((level) => level === 1)).toHaveLength(1)
    expect(levels[0]).toBe(1)
    for (const [index, level] of levels.entries()) {
      if (index > 0) expect(level).toBeLessThanOrEqual(levels[index - 1] + 1)
    }
  })
})

describe('homepage links the API documentation', () => {
  test.each(['/docs', '/docs/posts', '/openapi.json', '/llms.txt', '/mcp'])('links %s', (href) => {
    expect(landing).toContain(`href="${href}"`)
  })

  test('the links carry descriptive text, not bare URLs', () => {
    const text = textOf(landing)
    expect(text).toContain('API documentation')
    expect(text).toContain('OpenAPI 3.1 description')
    expect(text).toContain('MCP server')
  })

  test('the pre-rendered index.html carries the same anchors', () => {
    const rendered = prerender(indexHtml)
    for (const href of ['/docs', '/openapi.json', '/llms.txt', '/mcp', '/about', '/privacy']) {
      expect(rendered).toContain(`href="${href}"`)
    }
  })
})

describe.each(SLUGS)('/%s page', (slug) => {
  const html = pageBuilders[slug]()
  const text = textOf(html)

  test('renders one h1 and section headings', () => {
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1)
    expect((html.match(/<h2[\s>]/g) ?? []).length).toBeGreaterThanOrEqual(4)
  })

  test('carries well over the 500 characters trust checks look for', () => {
    expect(text.length).toBeGreaterThanOrEqual(700)
  })

  test('uses landmarks agents can navigate', () => {
    expect(html).toContain('<main id="content"')
    expect(html).toContain('<nav aria-label="Primary"')
    expect(html).toContain('<footer')
  })

  test('links the other trust anchors', () => {
    for (const other of SLUGS.filter((entry) => entry !== slug)) {
      expect(html).toContain(`href="/${other}"`)
    }
  })

  test('has a root HTML file with canonical and Markdown alternate', () => {
    const file = read(`${slug}.html`)
    expect(file).toContain(`<div id="app" data-page="${slug}"></div>`)
    expect(file).toContain(`<link rel="canonical" href="https://x.pcstyle.dev/${slug}" />`)
    expect(file).toContain(`<link rel="alternate" type="text/markdown" href="/${slug}.md"`)
    expect(file).toContain('<script type="module" src="/src/page.ts"></script>')

    const graph = graphOf(file)
    const crumbs = nodeOf(graph, 'BreadcrumbList').itemListElement as { position: number }[]
    expect(crumbs).toHaveLength(2)
  })
})

describe('page content is specific, not filler', () => {
  test('about explains ownership and affiliation', () => {
    const text = textOf(pageBuilders.about())
    expect(text).toContain('not affiliated with, endorsed by, or connected to X Corp')
    expect(text).toContain('MIT-licensed')
  })

  test('contact publishes only channels that exist in the repository', () => {
    const html = pageBuilders.contact()
    expect(html).toContain('https://github.com/pc-style/x-md/issues')
    expect(html).toContain('https://github.com/pc-style/x-md/security/advisories')
    expect(html).toContain('https://x.com/pcstyle53')
    // One real address, published deliberately. Anything else would be invented.
    expect(html).toContain('mailto:me@pcstyle.dev')
    expect(html).not.toMatch(/@x\.md|support@|hello@|contact@/)
  })

  test('privacy names the actual data paths', () => {
    const text = textOf(pageBuilders.privacy())
    for (const claim of ['rate limiting', 'PostHog', '__Host-xmd_actor', 'nocache', 'Vercel']) {
      expect(text).toContain(claim)
    }
  })

  test('terms disclaim warranty and affiliation', () => {
    const text = textOf(pageBuilders.terms())
    expect(text).toContain('as is and as available, without warranty of any kind')
    expect(text).toContain('not affiliated with, endorsed by, or connected to X Corp')
  })
})
