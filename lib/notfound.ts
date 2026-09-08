/**
 * The one 404 payload, shared by the catch-all handler and by the browse
 * handler's not-found branch so both families of missing path answer alike.
 *
 * An agent that lands on a dead URL has to be able to recover from the response
 * body alone, so every representation carries the same recovery links and the
 * same list of valid URL shapes. The status is 404 in every branch: a missing
 * resource is missing in every media type, so negotiation never downgrades it.
 */

import { problemDetails, problemMediaType, type ProblemDetails, type ProblemLink } from './apierror.js'
import { CONTENT_TYPE, selectRepresentation, type Repr } from './negotiate.js'

const SITE = 'https://x.pcstyle.dev'

/** Mirrors the link set blume already builds into /404.md and /404.json. */
export const NOT_FOUND_LINKS: ProblemLink[] = [
  { label: 'Home', href: `${SITE}/` },
  { label: 'Documentation', href: `${SITE}/docs` },
  { label: 'Sitemap', href: `${SITE}/sitemap.xml` },
  { label: 'Docs index for AI agents (llms.txt)', href: `${SITE}/llms.txt` },
  { label: 'JSON API description (openapi.json)', href: `${SITE}/openapi.json` },
  { label: 'JSON API index', href: `${SITE}/api` },
]

const URL_SHAPES: [string, string][] = [
  ['/{handle}', 'a public X profile'],
  ['/{handle}/status/{id}', 'a public post, thread, or conversation'],
  ['/{handle}/followers', 'accounts following a profile'],
  ['/{handle}/following', 'accounts a profile follows'],
  ['/search?q={query}', 'a public post or user search'],
]

const LINK_HEADER = [
  '</404.md>; rel="alternate"; type="text/markdown"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
  '</llms.txt>; rel="describedby"; type="text/plain"',
  '</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"',
].join(', ')

/**
 * The caller's path, safe to echo into markdown, HTML, and JSON. Rejects the
 * unexpanded `:path*` token, which is what arrives if the rewrite that carries
 * the original path ever stops interpolating.
 */
export function safePath(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw.join('/') : typeof raw === 'string' ? raw : undefined
  if (!value) return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f`<>"']/g, '').slice(0, 200).trim()
  if (!cleaned || cleaned.includes(':path')) return undefined
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`
}

/**
 * What to serve a caller that expressed no preference. Only a browser names
 * `text/html` explicitly, so no preference means a machine reader: it gets the
 * markdown recovery document, or problem details under /api. Serving the styled
 * page here would hand an agent an HTML dead end it has to parse out of.
 */
export function defaultRepresentation(path?: string): Repr {
  return path?.startsWith('/api') ? 'json' : 'markdown'
}

function sentence(path?: string, detail?: string): string {
  if (detail) return detail
  return path ? `No resource exists at ${path}.` : 'The requested URL does not exist.'
}

export function notFoundMarkdown(path?: string, detail?: string): string {
  return [
    '# 404 Not Found',
    '',
    sentence(path, detail),
    '',
    '## Where to look next',
    '',
    ...NOT_FOUND_LINKS.map((link) => `- [${link.label}](${link.href})`),
    '',
    '## Valid URL shapes',
    '',
    ...URL_SHAPES.map(([shape, description]) => `- \`${shape}\` - ${description}`),
    '',
  ].join('\n')
}

export function notFoundProblem(
  instance: string,
  path?: string,
  detail?: string,
  code = 'route_not_found',
): ProblemDetails {
  return problemDetails(code, {
    instance,
    detail: sentence(path, detail),
    status: 404,
    links: NOT_FOUND_LINKS,
  })
}

/**
 * A not-found sentence that matches what was actually looked up. The provider
 * reports every miss as "Post not found or unavailable.", which is wrong for a
 * profile or a follower list, so the resource decides the wording here.
 */
export function browseNotFoundDetail(resource?: string, handle?: string, message?: string): string {
  const account = handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `@${handle}` : 'that account'
  if (resource === 'profile') return `No public X profile at ${account}. It may be suspended, renamed, protected, or never have existed.`
  if (resource === 'followers') return `No public X profile at ${account}, so its followers cannot be listed.`
  if (resource === 'following') return `No public X profile at ${account}, so the accounts it follows cannot be listed.`
  if (resource === 'search') return 'No public posts matched that search.'
  return message || 'The requested X content is not public or no longer exists.'
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Compact HTML 404 that embeds the markdown recovery document in a `<pre>`, so
 * an agent that sent no Accept header still gets the machine-readable version
 * instead of a styled dead end.
 */
export function notFoundHtml(path?: string, detail?: string): string {
  const markdown = notFoundMarkdown(path, detail)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 Not Found - x.md</title>
<meta name="robots" content="noindex">
<link rel="alternate" type="text/markdown" href="/404.md">
<style>
:root{color-scheme:light dark}
body{margin:0;padding:3rem 1.25rem;background:#f7f6f2;color:#1a1915;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:44rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .5rem}
h2{font-size:1rem;letter-spacing:.02em;text-transform:uppercase;color:#6b6858;margin:2rem 0 .5rem}
a{color:#146c43}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
pre{white-space:pre-wrap;background:#fffdf7;border:1px solid #e5e2d9;border-radius:.5rem;padding:1rem;overflow-x:auto;font-size:.85rem}
@media(prefers-color-scheme:dark){body{background:#131310;color:#eceade}h2{color:#9a9684}a{color:#5fbc8a}pre{background:#1b1c17;border-color:#2c2e27}}
</style>
</head><body><main>
<h1>404 Not Found</h1>
<p>${escapeHtml(sentence(path, detail))}</p>
<h2>Where to look next</h2>
<ul>${NOT_FOUND_LINKS.map((link) => `<li><a href="${link.href}">${escapeHtml(link.label)}</a></li>`).join('')}</ul>
<h2>Valid URL shapes</h2>
<ul>${URL_SHAPES.map(([shape, description]) => `<li><code>${escapeHtml(shape)}</code> - ${escapeHtml(description)}</li>`).join('')}</ul>
<h2>Machine-readable version</h2>
<pre>${escapeHtml(markdown)}</pre>
</main></body></html>`
}

export interface NotFoundInit {
  /** Absolute URL of the request that failed, for the problem document. */
  instance: string
  accept?: string | null
  /** Path the caller asked for; echoed into every representation. */
  path?: string
  /** Occurrence-specific sentence replacing the generic one. */
  detail?: string
  code?: string
  /** Representation for a caller that expressed no preference. */
  fallback?: Repr
}

const OFFERS: Repr[] = ['html', 'markdown', 'json']

export function notFoundResponse(init: NotFoundInit): {
  status: number
  headers: Record<string, string>
  body: string
} {
  const accept = init.accept ?? ''
  // A caller that accepts none of these still gets the 404: the resource is
  // missing in every media type, so answering 406 would hide the real problem.
  const chosen = selectRepresentation(accept, OFFERS, init.fallback ?? defaultRepresentation(init.path)) ?? 'markdown'
  const problem = notFoundProblem(init.instance, init.path, init.detail, init.code)
  const body =
    chosen === 'json'
      ? `${JSON.stringify(problem, null, 2)}\n`
      : chosen === 'markdown'
        ? notFoundMarkdown(init.path, init.detail)
        : notFoundHtml(init.path, init.detail)

  return {
    status: 404,
    headers: {
      'Content-Type': chosen === 'json' ? `${problemMediaType(accept)}; charset=utf-8` : CONTENT_TYPE[chosen],
      'Cache-Control': 'public, max-age=0, must-revalidate',
      Vary: 'Accept',
      Link: LINK_HEADER,
    },
    body,
  }
}
