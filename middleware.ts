import { next, rewrite } from '@vercel/functions'
import { notAcceptableBody, selectRepresentation } from './lib/negotiate.js'
import { DOMAIN_PREFIX, PARALLEL_HOSTS, domainFile } from './lib/domain-pages.js'

/**
 * Content negotiation for the HTML pages.
 *
 * `vercel.json` rewrites run after the filesystem, so nothing in config can
 * intercept `/` once `index.html` exists. Routing Middleware runs before both
 * the filesystem and the cache, so it is the only place an agent asking for
 * `Accept: text/markdown` can be handed the Markdown twin of a page.
 *
 * Domain variants include static docs, discovery documents, and social cards.
 * All API, permalink, and shared asset requests immediately pass through.
 */
export const config = {
  matcher: ['/:path*'],
}

const DISCOVERY_LINKS = [
  '</.well-known/ard.json>; rel="describedby"; type="application/json"',
  '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
]

function markdownSibling(pathname: string): string {
  if (pathname === '/') return '/index.md'
  return `${pathname.replace(/\/+$/, '')}.md`
}

export default function middleware(request: Request): Response {
  const url = new URL(request.url)
  const variant = (path: string) => PARALLEL_HOSTS.has(url.hostname) && domainFile(path)
    ? `${DOMAIN_PREFIX}/${domainFile(path)}` : path
  const file = domainFile(url.pathname)
  const isNegotiated = ['/', '/docs', '/about', '/contact', '/privacy', '/terms'].includes(url.pathname)
    || (url.pathname.startsWith('/docs/') && !/\.[a-z0-9]+$/i.test(url.pathname))

  if (!isNegotiated) {
    return PARALLEL_HOSTS.has(url.hostname) && file
      ? rewrite(new URL(`${DOMAIN_PREFIX}/${file}`, request.url)) : next()
  }

  // The matcher also catches files under /docs (llms.txt, the .md twins
  // themselves). Those are already the representation they are; negotiating
  // them would rewrite /docs/llms.txt to /docs/llms.txt.md and 404.
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return next()

  const md = markdownSibling(url.pathname)
  const alternate = `<${md}>; rel="alternate"; type="text/markdown"`
  const link = [alternate, ...DISCOVERY_LINKS].join(', ')

  // An explicit agent view, so an agent can ask for Markdown without having to
  // set an Accept header at all.
  if (url.searchParams.get('mode') === 'agent') {
    return rewrite(new URL(variant(md), request.url), { headers: { Vary: 'Accept', Link: link } })
  }

  const accept = request.headers.get('accept')
  const chosen = selectRepresentation(accept, ['html', 'markdown'], 'html')

  if (chosen === null) {
    return new Response(notAcceptableBody(['html', 'markdown'], accept), {
      status: 406,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        Vary: 'Accept',
        Link: link,
      },
    })
  }

  if (chosen === 'markdown') {
    return rewrite(new URL(variant(md), request.url), { headers: { Vary: 'Accept', Link: link } })
  }

  if (PARALLEL_HOSTS.has(url.hostname) && file) {
    return rewrite(new URL(`${DOMAIN_PREFIX}/${file}`, request.url), {
      headers: { Vary: 'Accept', Link: link },
    })
  }

  return next({ headers: { Vary: 'Accept', Link: link } })
}
