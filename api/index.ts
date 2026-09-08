import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import {
  ERROR_CATALOG,
  ERRORS_DOC,
  LEGACY_DEPRECATION,
  LEGACY_SUNSET,
  LEGACY_SUNSET_ISO,
  VERSIONING_DOC,
  problemDetails,
  requestInstance,
  sendProblem,
} from '../lib/apierror.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import { CONTENT_TYPE, selectRepresentation } from '../lib/negotiate.js'

interface Operation {
  operationId: string
  method: string
  path: string
  description: string
  example?: string
}

function operations(origin: string): Operation[] {
  return [
    {
      operationId: 'getPost',
      method: 'GET',
      path: '/api/v1/posts',
      description: 'Read one public X post, thread, or conversation as Markdown or JSON.',
      example: `${origin}/api/v1/posts?url=https://x.com/jack/status/20`,
    },
    {
      operationId: 'getProfile',
      method: 'GET',
      path: '/api/v1/profiles/{handle}',
      description: 'Read a public profile and its latest original posts.',
      example: `${origin}/api/v1/profiles/jack?format=json`,
    },
    {
      operationId: 'listFollowers',
      method: 'GET',
      path: '/api/v1/profiles/{handle}/followers',
      description: 'List the accounts following a public profile.',
      example: `${origin}/api/v1/profiles/jack/followers`,
    },
    {
      operationId: 'listFollowing',
      method: 'GET',
      path: '/api/v1/profiles/{handle}/following',
      description: 'List the accounts a public profile follows.',
      example: `${origin}/api/v1/profiles/jack/following`,
    },
    {
      operationId: 'searchPosts',
      method: 'GET',
      path: '/api/v1/search',
      description: 'Search public posts or users.',
      example: `${origin}/api/v1/search?q=vercel&format=json`,
    },
    {
      operationId: 'getOEmbed',
      method: 'GET',
      path: '/api/v1/oembed',
      description: 'oEmbed document for a public X status URL.',
      example: `${origin}/api/v1/oembed?url=https://x.com/jack/status/20`,
    },
    {
      operationId: 'getPostByPermalink',
      method: 'GET',
      path: '/{handle}/status/{id}',
      description: 'The same post reader, reachable by rewriting an x.com permalink to this host.',
      example: `${origin}/jack/status/20`,
    },
    {
      operationId: 'getProfileByHandle',
      method: 'GET',
      path: '/{handle}',
      description: 'The same profile reader, reachable by handle.',
      example: `${origin}/jack`,
    },
    {
      operationId: 'searchPostsByPath',
      method: 'GET',
      path: '/search',
      description: 'The same search, reachable as a plain path.',
      example: `${origin}/search?q=vercel`,
    },
  ]
}

/** The JSON document served at /api. */
export function apiIndexDocument(origin: string) {
  return {
    name: 'x.md',
    description:
      'Read-only HTTP API over public X (Twitter) content. Every operation is a GET, needs no authentication, and returns compact Markdown by default or JSON with `format=json` or `Accept: application/json`. x.md never posts, follows, likes, or writes anything to X.',
    version: 'v1',
    documentation_url: `${origin}/docs`,
    openapi_url: `${origin}/openapi.json`,
    api_catalog_url: `${origin}/.well-known/api-catalog`,
    llms_txt_url: `${origin}/llms.txt`,
    mcp_url: `${origin}/mcp`,
    terms_url: `${origin}/terms`,
    contact_url: `${origin}/contact`,
    source_url: 'https://github.com/pc-style/x-md',
    authentication: {
      required: false,
      scheme: 'Bearer',
      description:
        'The public API needs no credentials. An optional `Authorization: Bearer <key>` raises the rate limits for live search.',
    },
    versioning: {
      current: 'v1',
      base_path: '/api/v1',
      policy_url: VERSIONING_DOC,
      description:
        'Breaking changes ship as a new path version. The permalink routes are unversioned and stable. Deprecated routes answer with RFC 9745 `Deprecation` and RFC 8594 `Sunset` headers plus a `successor-version` link.',
      deprecated_aliases: [
        {
          path: '/api/convert',
          successor: '/api/v1/posts',
          deprecation: LEGACY_DEPRECATION,
          sunset: LEGACY_SUNSET,
          sunset_iso: LEGACY_SUNSET_ISO,
        },
        {
          path: '/api/browse',
          successor: '/api/v1/profiles/{handle}, /api/v1/search',
          deprecation: LEGACY_DEPRECATION,
          sunset: LEGACY_SUNSET,
          sunset_iso: LEGACY_SUNSET_ISO,
        },
      ],
    },
    endpoints: operations(origin),
    errors: {
      media_type: 'application/problem+json',
      specification: 'https://www.rfc-editor.org/rfc/rfc9457',
      documentation_url: ERRORS_DOC,
      description:
        'Every failure answers with RFC 9457 problem details carrying a stable `code`, a human `detail`, and a `resolution` hint.',
      codes: Object.entries(ERROR_CATALOG).map(([code, entry]) => ({
        code,
        status: entry.status,
        title: entry.title,
        resolution: entry.resolution,
      })),
    },
    links: {
      self: `${origin}/api`,
      openapi: `${origin}/openapi.json`,
      documentation: `${origin}/docs`,
      llms_txt: `${origin}/llms.txt`,
      api_catalog: `${origin}/.well-known/api-catalog`,
      mcp: `${origin}/mcp`,
      sitemap: `${origin}/sitemap.xml`,
    },
  }
}

/** The same index as prose, for an agent that asked for Markdown. */
export function apiIndexMarkdown(origin: string): string {
  const doc = apiIndexDocument(origin)
  return [
    '---',
    'title: x.md API index',
    `description: ${doc.description.split('.')[0]}.`,
    `canonical: ${origin}/api`,
    '---',
    '',
    '# x.md API index',
    '',
    doc.description,
    '',
    '## Endpoints',
    '',
    ...doc.endpoints.map(
      (endpoint) =>
        `- \`${endpoint.method} ${endpoint.path}\` - ${endpoint.description}${endpoint.example ? ` Example: ${endpoint.example}` : ''}`,
    ),
    '',
    '## Authentication',
    '',
    doc.authentication.description,
    '',
    '## Versioning',
    '',
    doc.versioning.description,
    ...doc.versioning.deprecated_aliases.map(
      (alias) => `- \`${alias.path}\` is deprecated; use \`${alias.successor}\`. Sunset ${alias.sunset_iso}.`,
    ),
    `- Policy: ${doc.versioning.policy_url}`,
    '',
    '## Errors',
    '',
    `${doc.errors.description} Media type \`${doc.errors.media_type}\` (${doc.errors.specification}).`,
    '',
    '| Code | Status | What to do |',
    '| --- | --- | --- |',
    ...doc.errors.codes.map((error) => `| \`${error.code}\` | ${error.status} | ${error.resolution} |`),
    '',
    '## Discovery',
    '',
    ...Object.entries(doc.links).map(([rel, href]) => `- ${rel}: ${href}`),
    '',
  ].join('\n')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'index')
  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  if (req.method === 'OPTIONS') {
    applyQuotaPolicyOnly(res, 'read', caller)
    return res.status(204).end()
  }

  const origin = requestOrigin(req)
  const accept = String(req.headers.accept ?? '')
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    return sendProblem(
      res,
      problemDetails('method_not_allowed', {
        instance: requestInstance(req, origin),
        detail: `${req.method} is not supported on /api. x.md is read-only.`,
      }),
      accept,
      req.method,
    )
  }

  // The index is itself an API response, so it reports the same allowance the
  // operations it describes will charge.
  const quota = await chargeRequestQuota('read', caller)
  applyRequestQuota(res, quota)
  if (!quota.allowed) {
    applyExhaustedQuota(res, quota, 'api-ip', quota.retryAfter)
    return sendProblem(
      res,
      problemDetails('rate_limited', {
        instance: requestInstance(req, origin),
        detail: 'Too many requests from this address. Cached responses do not count against the allowance.',
        retryAfter: quota.retryAfter,
      }),
      accept,
      req.method,
    )
  }

  // A browser asking only for HTML still gets the JSON index: an API index that
  // answers 406 is less useful than one that always describes the API.
  const chosen = selectRepresentation(accept, ['json', 'markdown'], 'json') ?? 'json'
  const body = chosen === 'markdown' ? apiIndexMarkdown(origin) : `${JSON.stringify(apiIndexDocument(origin), null, 2)}\n`

  res.setHeader('Content-Type', CONTENT_TYPE[chosen])
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
  res.setHeader('Vary', 'Accept')
  res.setHeader(
    'Link',
    [
      `<${origin}/openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"`,
      `<${origin}/docs>; rel="service-doc"; type="text/html"`,
      `<${origin}/.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"`,
      `<${origin}/llms.txt>; rel="describedby"; type="text/plain"`,
      // No rel="deprecation" here: that relation says its own context is
      // deprecated, and /api is not. The policy URL is in the body instead.
    ].join(', '),
  )
  return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(body)
}
