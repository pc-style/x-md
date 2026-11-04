import { next, rewrite } from '@vercel/functions'
import { notAcceptableBody, selectRepresentation } from './lib/negotiate.js'
import { domainFile } from './lib/domain-pages.js'

/**
 * Content negotiation for the HTML pages.
 *
 * `vercel.json` rewrites run after the filesystem, so nothing in config can
 * intercept `/` once `index.html` exists. Routing Middleware runs before both
 * the filesystem and the cache, so it is the only place an agent asking for
 * `Accept: text/markdown` can be handed the Markdown twin of a page.
 *
 * Host-aware responses include static docs, discovery documents, and social cards.
 * All API, permalink, and shared asset requests immediately pass through, after
 * slashed paths that `vercel.json` cannot match are sent to their canonical form.
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

// Vercel compiles every `vercel.json` source in strict mode, so a trailing
// slash matches no rewrite, not even the `/:path*` catch-all, and the platform's
// bare 404 answers instead of the route or the structured `route_not_found`.
// These slash forms are served as they are: the docs directories and the
// explicit `/` rewrites. Every other one is redirected to its slashless route.
const SERVED_WITH_SLASH = /^\/(?:docs\/.*|mcp\/(?:server-card\/)?|[A-Za-z0-9_]{1,15}\/status\/\d+\/(?:(?:video|photo)\/[1-9]\d*\/)?)$/

function markdownSibling(pathname: string): string {
  if (pathname === '/') return '/index.md'
  return `${pathname.replace(/\/+$/, '')}.md`
}

export default function middleware(request: Request): Response {
  const url = new URL(request.url)
  if (url.pathname !== '/' && url.pathname.endsWith('/') && !SERVED_WITH_SLASH.test(url.pathname)) {
    // Set the pathname rather than resolving a string, so `//host/` stays on this origin.
    url.pathname = url.pathname.replace(/\/+$/, '')
    return Response.redirect(url, 308)
  }
  // Only `path` selects a host-rendered asset. Any other parameter would make a
  // fresh CDN cache key and force a render, so send it to the canonical URL.
  if (url.pathname === '/api/site') {
    const path = url.searchParams.get('path')
    const canonical = path === null ? '' : `?${new URLSearchParams({ path })}`
    if (url.search !== canonical) return Response.redirect(new URL(`/api/site${canonical}`, request.url), 308)
  }
  const needsHost = url.hostname !== 'mdfromx.com'
  const variant = (path: string) => needsHost && domainFile(path)
    ? `/api/site?${new URLSearchParams({ path })}` : path
  const file = domainFile(url.pathname)
  const isNegotiated = ['/', '/docs', '/about', '/contact', '/privacy', '/terms'].includes(url.pathname)
    || (url.pathname.startsWith('/docs/') && !/\.[a-z0-9]+$/i.test(url.pathname))

  if (!isNegotiated) {
    return needsHost && file
      ? rewrite(new URL(variant(url.pathname), request.url)) : next()
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

  if (needsHost && file) {
    return rewrite(new URL(variant(url.pathname), request.url), {
      headers: { Vary: 'Accept', Link: link },
    })
  }

  return next({ headers: { Vary: 'Accept', Link: link } })
}
