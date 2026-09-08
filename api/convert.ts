import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem, setDeprecationHeaders } from '../lib/apierror.js'
import { captureArchive } from '../lib/archive.js'
import { ConvertError, acceptPrefersHtml, convertTweet, markdownResponse } from '../lib/converter.js'
import { embedResponse, isEmbedUserAgent } from '../lib/embed.js'
import { requestOrigin, setCorsHeaders, wantsJson, wantsMarkdown } from '../lib/http.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'convert')
  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  if (req.method === 'OPTIONS') {
    applyQuotaPolicyOnly(res, 'read', caller)
    return res.status(204).end()
  }

  const param = (key: string): string | undefined => (typeof req.query[key] === 'string' ? req.query[key] : undefined)
  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, requestOrigin(req))

  // Charged before anything can return, so every response — success, error and
  // 405 alike — tells the caller how much room is left.
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

  // A vercel.json rewrite hands the function its destination path, so the
  // permalink routes arrive here looking like /api/convert too. They are the
  // only ones that can be told apart (they inject handle and id), so the
  // deprecated alias is "a direct /api/convert call that is not a permalink".
  // `via=route` lets a rewrite opt out explicitly once one carries the marker.
  if (
    (req.url ?? '').split('?')[0] === '/api/convert' &&
    param('via') !== 'route' &&
    !(param('handle') && param('id'))
  ) {
    setDeprecationHeaders(res, '/api/v1/posts')
  }

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

  const userAgent = String(req.headers['user-agent'] ?? '')
  const requestedFormat = param('format')
  const asJson = wantsJson(requestedFormat, accept)
  const asMarkdown = wantsMarkdown(requestedFormat, accept)
  const asEmbed = !requestedFormat && !asJson && !asMarkdown && isEmbedUserAgent(userAgent)
  const asHtml = !requestedFormat && !asJson && !asMarkdown && !asEmbed && acceptPrefersHtml(accept)

  try {
    const result = await convertTweet({
      url: param('url'),
      handle: param('handle'),
      id: param('id'),
      format: requestedFormat,
      thread: param('thread'),
      userinfo: param('userinfo'),
      nocache: param('nocache'),
      full: param('full'),
      context: param('context'),
      replies: param('replies'),
    })

    const { status, headers, body } = asEmbed
      ? embedResponse(result, { origin: requestOrigin(req), userAgent })
      : markdownResponse(result, asJson, asHtml)
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }

    if (status === 200) captureArchive(req, res, { ...result, resource: 'tweet', degraded: result.source !== 'fxtwitter' })

    if (req.method === 'HEAD') {
      return res.status(status).end()
    }

    return res.status(status).send(body)
  } catch (error) {
    if (!(error instanceof ConvertError)) console.error(error)
    return sendProblem(res, problemFrom(error, instance), accept, req.method)
  }
}
