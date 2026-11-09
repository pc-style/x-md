import { withServerEvents, trackResult } from '../lib/server-events.js'
import { withErrorTracking } from '../lib/error-tracking.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem, setDeprecationHeaders } from '../lib/apierror.js'
import { captureArchive } from '../lib/archive.js'
import { ConvertError, POST_REPRESENTATIONS, acceptPrefersHtml, convertTweet, markdownResponse } from '../lib/converter.js'
import { embedResponse, isEmbedUserAgent } from '../lib/embed.js'
import { acceptedRepresentation, requestOrigin, setCorsHeaders, wantsJson, wantsMarkdown } from '../lib/http.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import { callerHeaders, keyRequirementFailure, resolveCaller } from '../lib/apiauth.js'

async function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'convert')
  setCorsHeaders(res)
  const caller = { ip: clientIp(req.headers) }
  const param = (key: string): string | undefined => (typeof req.query[key] === 'string' ? req.query[key] : undefined)

  // A vercel.json rewrite hands the function its destination path, so the
  // permalink and versioned routes arrive here looking like /api/convert too;
  // every one of them carries via=route, so a request without it is a direct
  // call to the deprecated alias. RFC 9745 wants the signal on every response,
  // preflights and errors included, hence before anything can return.
  if ((req.url ?? '').split('?')[0] === '/api/convert' && param('via') !== 'route') {
    setDeprecationHeaders(res, '/api/v1/posts')
  }
  if (req.method === 'OPTIONS') {
    applyQuotaPolicyOnly(res, 'read', caller)
    return res.status(204).end()
  }

  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, requestOrigin(req))

  // The charge and the cache lookup touch different keys, so the lookup starts
  // while the charge is in flight. Nothing is served or fetched until `admit`
  // opens the gate after the last check below; any earlier answer closes it.
  let admit: (allowed: boolean) => void = () => undefined
  const gate = new Promise<boolean>((resolve) => { admit = resolve })
  const pending = req.method === 'GET' || req.method === 'HEAD'
    ? convertTweet({
      origin: requestOrigin(req),
      url: param('url'),
      handle: param('handle'),
      id: param('id'),
      format: param('format'),
      thread: param('thread'),
      userinfo: param('userinfo'),
      nocache: param('nocache'),
      full: param('full'),
      context: param('context'),
      replies: param('replies'),
    }, { admission: gate })
    : undefined
  pending?.catch(() => undefined)

  try {
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
    const asJson = wantsJson(requestedFormat, accept, POST_REPRESENTATIONS)
    const asMarkdown = wantsMarkdown(requestedFormat, accept, POST_REPRESENTATIONS)
    const asEmbed = !requestedFormat && !asJson && !asMarkdown && isEmbedUserAgent(userAgent)
    const asHtml = !requestedFormat && !asJson && !asMarkdown && !asEmbed && acceptPrefersHtml(accept)

    // Private mode: the permalink surface is API too, so it needs a key as well.
    // Only an actual Open Graph card is exempt: a preview bot's user agent asking
    // for JSON or Markdown is data access and is gated like any other caller.
    // Unfurlers never send credentials, so a request presenting any Authorization
    // header that is not a valid key is an API caller and gets no exemption.
    const resolved = await resolveCaller(req.headers)
    for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
    // A presented key that does not verify is refused, as on every other read
    // route, rather than silently served as anonymous.
    if (resolved.status === 'invalid') {
      return sendProblem(res, problemDetails('invalid_key', { instance, detail: 'Invalid or disabled API key.' }), accept, req.method)
    }
    const keyFailure = keyRequirementFailure(resolved)
    if (keyFailure && !(asEmbed && !req.headers.authorization)) {
      return sendProblem(res, problemDetails('unauthorized', { instance, detail: keyFailure }), accept, req.method)
    }
    // Accept refused every representation a post has. A preview bot still gets its card.
    if (!requestedFormat && !asEmbed && acceptedRepresentation(accept, POST_REPRESENTATIONS) === null) {
      return sendProblem(res, problemDetails('not_acceptable', { instance, detail: 'Accept refuses text/markdown, application/json and text/html, the only representations of a post.' }), accept, req.method)
    }

    try {
      admit(true)
      const result = await pending!

      trackResult(result)
      const { status, headers, body } = asEmbed
        ? embedResponse(result, { origin: requestOrigin(req), userAgent })
        : markdownResponse(result, asJson, asHtml)
      for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value)
      }
      // A keyed response stays out of shared caches whatever the renderer chose.
      for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)

      if (status === 200) captureArchive(req, res, { ...result, resource: 'tweet', degraded: result.source !== 'fxtwitter' })

      if (req.method === 'HEAD') {
        return res.status(status).end()
      }

      return res.status(status).send(body)
    } catch (error) {
      if (!(error instanceof ConvertError)) console.error(error)
      return sendProblem(res, problemFrom(error, instance), accept, req.method)
    }
  } finally {
    admit(false)
  }
}

export default withErrorTracking(withServerEvents('convert', handler))
