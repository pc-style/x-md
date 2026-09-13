export const PARALLEL_HOST = 'mdfromx.com'
/** Older service URLs accepted as converter input on every host. */
export const PARALLEL_HOSTS: ReadonlySet<string> = new Set([PARALLEL_HOST, `fast.${PARALLEL_HOST}`])
/** Adapt authored service references; third-party URLs keep their original hosts. */
export function domainText(source: string, origin: string): string {
  const { host } = new URL(origin)
  return source.replace(/(https:\/\/)?(?:x\.pcstyle\.dev|(?:fast\.)?mdfromx\.com)/g,
    (_match, scheme) => scheme ? origin : host)
}

const PAGES = new Set(['about', 'contact', 'privacy', 'terms'])
const FILES = new Set([
  '404.html', '404.md', '404.json', 'index.html', 'index.md', 'index.mdx', 'docs.md', 'docs.mdx',
  'llms.txt', 'llms-full.txt', 'auth.md', 'pricing.md', 'agents.md',
  'robots.txt', 'sitemap.xml', 'schemamap.xml', 'openapi.json', 'server.json',
  'site.webmanifest', '.well-known/ard.json', '.well-known/ai-catalog.json',
  'blume-search.json', 'agent-readability.json',
  '.well-known/api-catalog', '.well-known/mcp/server-card.json',
])

/** Only public build output is eligible; API and permalink routes pass through. */
export function domainFile(pathname: string): string | null {
  if (!/^\/[a-zA-Z0-9_./-]*$/.test(pathname) || pathname.split('/').some(part => part === '.' || part === '..')) return null
  const path = pathname.replace(/^\//, '').replace(/\/$/, '')
  if (!path) return 'index.html'
  if (PAGES.has(path)) return `${path}.html`
  if (/^(about|contact|privacy|terms)\.(html|md)$/.test(path) || FILES.has(path)) return path
  if (path === '.well-known/security.txt' || /^feeds\/[a-zA-Z0-9_-]+\.jsonl$/.test(path)) return path
  if (path === 'og.png') return 'og.png'
  if (/^og\/docs(?:\/[^.\/]+)*\.png$/.test(path)) return path
  if (path === 'docs') return 'docs/index.html'
  if (path.startsWith('docs/')) return /\.[a-z]+$/i.test(path) ? path : `${path}/index.html`
  if (path.startsWith('api/docs/') && path.endsWith('.json')) return path
  if (path.startsWith('.well-known/agent-skills/')) return path
  return null
}
