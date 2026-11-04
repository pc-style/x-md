import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { withErrorTracking } from '../lib/error-tracking.js'
import { problemDetails, sendProblem } from '../lib/apierror.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import { notFoundResponse, safePath } from '../lib/notfound.js'

/**
 * The negotiated 404 every unmatched path is rewritten to.
 *
 * A static rewrite would answer 200 with a page shell, which teaches an agent
 * that every URL exists; this stays 404 in every branch and hands back a
 * recovery document in the media type the caller asked for.
 */
export async function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'notfound')
  // Any method can land on a path that does not exist, so the preflight answer
  // is wider than the read-only routes'.
  setCorsHeaders(res, 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
  const caller = { ip: clientIp(req.headers) }
  if (req.method === 'OPTIONS') {
    applyQuotaPolicyOnly(res, 'read', caller)
    return res.status(204).end()
  }

  const origin = requestOrigin(req)
  // The rewrite carries the original path; req.url is this handler's own path.
  const fromUrl = safePath((req.url ?? '').split('?')[0])
  const path = safePath(req.query.path) ?? (fromUrl === '/api/notfound' ? undefined : fromUrl)

  // A miss spends the same front door as a real route: random paths are free to
  // invent, so without the charge they are an unthrottled way to run the function.
  const quota = await chargeRequestQuota('read', caller)
  applyRequestQuota(res, quota)
  if (!quota.allowed) {
    applyExhaustedQuota(res, quota, 'api-ip', quota.retryAfter)
    return sendProblem(
      res,
      problemDetails('rate_limited', {
        instance: new URL(path ?? '/', origin).toString(),
        detail: 'Too many requests from this address.',
        retryAfter: quota.retryAfter,
      }),
      req.headers.accept ?? '',
      req.method,
    )
  }

  const { status, headers, body } = notFoundResponse({
    instance: new URL(path ?? '/', origin).toString(),
    accept: req.headers.accept,
    path,
  })
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
  // The CDN answers repeats of the same miss for a short while, so a hot dead
  // link costs one invocation per window rather than one per hit.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, must-revalidate')
  res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=60')
  return req.method === 'HEAD' ? res.status(status).end() : res.status(status).send(body)
}

export default withErrorTracking(handler)
