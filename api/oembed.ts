import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem } from '../lib/apierror.js'
import { oembedResponse } from '../lib/embed.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'oembed')
  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  if (req.method === 'OPTIONS') {
    applyQuotaPolicyOnly(res, 'read', caller)
    return res.status(204).end()
  }

  const origin = requestOrigin(req)
  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, origin)

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    return sendProblem(
      res,
      problemDetails('method_not_allowed', {
        instance,
        detail: `${req.method} is not supported on this route. x.md only reads public X content.`,
      }),
      accept,
      req.method,
    )
  }

  // Charged before anything can return, so every response carries the caller's
  // remaining allowance, not just a 429.
  const quota = await chargeRequestQuota('read', caller)
  applyRequestQuota(res, quota)
  if (!quota.allowed) {
    applyExhaustedQuota(res, quota, 'api-ip', quota.retryAfter)
    return sendProblem(
      res,
      problemDetails('rate_limited', {
        instance,
        detail: 'Too many requests from this address. Cached responses do not count against the allowance.',
        retryAfter: quota.retryAfter,
      }),
      accept,
      req.method,
    )
  }

  const param = (key: string): string | undefined => (typeof req.query[key] === 'string' ? req.query[key] : undefined)
  try {
    const { status, headers, body } = oembedResponse(
      {
        url: param('url'),
        text: param('text'),
        author: param('author'),
        status: param('status'),
        provider: param('provider'),
      },
      origin,
    )
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }
    return req.method === 'HEAD' ? res.status(status).end() : res.status(status).send(body)
  } catch (error) {
    console.error(error)
    return sendProblem(res, problemFrom(error, instance), accept, req.method)
  }
}
