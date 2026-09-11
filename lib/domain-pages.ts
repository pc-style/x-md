export const PARALLEL_HOST = 'mdfromx.com'
/** Hosts served from the mdfromx.com variant tree; dynamic self-links may name any of them. */
export const PARALLEL_HOSTS: ReadonlySet<string> = new Set([PARALLEL_HOST, `fast.${PARALLEL_HOST}`])
export const DOMAIN_PREFIX = '/_domains/mdfromx'

/** Built text variants preserve all wording except the service hostname. */
export function domainText(source: string): string {
  return source.replaceAll('x.pcstyle.dev', PARALLEL_HOST)
    .replaceAll(`${PARALLEL_HOST}/og.png`, `${PARALLEL_HOST}/og/mdfromx-v1.png`)
}

const PAGES = new Set(['about', 'contact', 'privacy', 'terms'])
const FILES = new Set([
  'index.html', 'index.md', 'index.mdx', 'docs.md', 'docs.mdx',
  'llms.txt', 'llms-full.txt', 'auth.md', 'pricing.md', 'agents.md',
  'robots.txt', 'sitemap.xml', 'schemamap.xml', 'openapi.json', 'server.json',
  'site.webmanifest', '.well-known/ard.json', '.well-known/ai-catalog.json',
  'blume-search.json', 'agent-readability.json',
  '.well-known/api-catalog', '.well-known/mcp/server-card.json',
])

/** Only static public pages enter the variant tree; API and permalink routes do not. */
export function domainFile(pathname: string): string | null {
  const path = pathname.replace(/^\//, '').replace(/\/$/, '')
  if (!path) return 'index.html'
  if (PAGES.has(path)) return `${path}.html`
  if (/^(about|contact|privacy|terms)\.(html|md)$/.test(path) || FILES.has(path)) return path
  if (path === 'og.png') return 'og.png'
  if (/^og\/docs(?:\/[^.\/]+)*\.png$/.test(path)) return path
  if (path === 'docs') return 'docs/index.html'
  if (path.startsWith('docs/')) return /\.[a-z]+$/i.test(path) ? path : `${path}/index.html`
  if (path.startsWith('api/docs/') && path.endsWith('.json')) return path
  if (path.startsWith('.well-known/agent-skills/')) return path
  return null
}
