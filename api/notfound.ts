import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { applyQuotaPolicyOnly } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import { notFoundResponse, safePath } from '../lib/notfound.js'

/**
 * The negotiated 404 every unmatched path is rewritten to.
 *
 * A static rewrite would answer 200 with a page shell, which teaches an agent
 * that every URL exists; this stays 404 in every branch and hands back a
 * recovery document in the media type the caller asked for.
 */
export default function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'notfound')
  // Any method can land on a path that does not exist, so the preflight answer
  // is wider than the read-only routes'.
  setCorsHeaders(res, 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
  // Policy only: a miss should not cost a counter round-trip, but an agent
  // that lands here still learns what the quotas are.
  applyQuotaPolicyOnly(res, 'read', { ip: clientIp(req.headers) })
  if (req.method === 'OPTIONS') return res.status(204).end()

  const origin = requestOrigin(req)
  // The rewrite carries the original path; req.url is this handler's own path.
  const fromUrl = safePath((req.url ?? '').split('?')[0])
  const path = safePath(req.query.path) ?? (fromUrl === '/api/notfound' ? undefined : fromUrl)

  const { status, headers, body } = notFoundResponse({
    instance: new URL(path ?? '/', origin).toString(),
    accept: req.headers.accept,
    path,
  })
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  return req.method === 'HEAD' ? res.status(status).end() : res.status(status).send(body)
}
