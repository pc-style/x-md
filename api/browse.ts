import { withServerEvents, trackResult } from '../lib/server-events.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem, setDeprecationHeaders } from '../lib/apierror.js'
import { captureArchive } from '../lib/archive.js'
import { callerHeaders, resolveCaller } from '../lib/apiauth.js'
import { browse, browseResponse } from '../lib/browse.js'
import { ConvertError } from '../lib/errors.js'
import { requestOrigin, setCorsHeaders, wantsJson } from '../lib/http.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota, type QuotaCaller, type QuotaScope } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import { browseNotFoundDetail, notFoundResponse } from '../lib/notfound.js'

/** The v1 path that replaces this exact legacy call, or nothing when it names no resource. */
export function browseSuccessor(resource?: string, handle?: string): string | undefined {
  if (resource === 'search') return '/api/v1/search'
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return undefined
  if (resource === 'followers' || resource === 'following') return `/api/v1/profiles/${handle}/${resource}`
  if (resource === 'profile') return `/api/v1/profiles/${handle}`
  return undefined
}

async function handler(req: VercelRequest, res: VercelResponse) {
  const identity = trackRequest(req, res, 'browse', req.query.resource)
  setCorsHeaders(res)
  // Preflight, 405 and a rejected key are never charged, so they advertise the
  // policy alone; a charged request overwrites this with its own state below.
  // No key is resolved this early, so an uncharged response names the anonymous
  // shape of the policy, which is the only one it can honestly claim.
  applyQuotaPolicyOnly(res, req.query.resource === 'search' ? 'search' : 'read', { ip: clientIp(req.headers) })
  if (req.method === 'OPTIONS') return res.status(204).end()

  const param = (key: string): string | undefined => typeof req.query[key] === 'string' ? req.query[key] : undefined
  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, requestOrigin(req))

  // Every vercel.json rewrite that lands here carries via=route, so a request
  // still on the bare /api/browse path is a direct call to the legacy alias.
  // RFC 9745 wants the signal on error responses too, hence before the guards.
  if ((req.url ?? '').split('?')[0] === '/api/browse' && param('via') !== 'route') {
    setDeprecationHeaders(res, browseSuccessor(param('resource'), param('handle')))
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

  const resolved = await resolveCaller(req.headers)
  if (resolved.status === 'valid' && resolved.caller.kind === 'key') identity.keyId = resolved.caller.id
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  if (resolved.status === 'invalid') {
    return sendProblem(
      res,
      problemDetails('invalid_key', { instance, detail: 'Invalid or disabled API key.' }),
      accept,
      req.method,
    )
  }

  // Search spends the deeper allowances too, so its quota report names all of
  // them; a profile or connection read only touches the front door.
  const scope: QuotaScope = param('resource') === 'search' ? 'search' : 'read'
  const quotaCaller: QuotaCaller =
    resolved.caller.kind === 'key'
      ? { ip: resolved.ip, key: { id: resolved.caller.id, limit: resolved.caller.limit } }
      : { ip: resolved.ip }
  const quota = await chargeRequestQuota(scope, quotaCaller)
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

  try {
    const result = await browse({ resource: param('resource'), handle: param('handle'), q: param('q'), feed: param('feed'), cursor: param('cursor'), page: param('page'), limit: param('limit'), full: param('full'), format: param('format'), nocache: param('nocache'), with_replies: param('with_replies'), with_reposts: param('with_reposts'), until: param('until'), ip: resolved.ip, caller: resolved.caller })
    trackResult(result)
    const response = browseResponse(result, wantsJson(param('format'), accept))
    for (const [key, header] of Object.entries(response.headers)) res.setHeader(key, header)
    // Keyed responses stay private even if the browse layer marked them cacheable.
    for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
    if (response.status === 200) captureArchive(req, res, result, identity)
    return req.method === 'HEAD' ? res.status(response.status).end() : res.status(response.status).send(response.body)
  } catch (error) {
    // A miss on a profile, follower list, or search is a routing dead end for an
    // agent, so it answers with the same recovery document as an unknown path
    // rather than a bare error string.
    if (error instanceof ConvertError && error.status === 404) {
      const { status, headers, body } = notFoundResponse({
        instance,
        // An explicit ?format=json outranks Accept, as it does on success.
        accept: param('format') === 'json' ? 'application/json' : accept,
        detail: browseNotFoundDetail(param('resource'), param('handle'), error.message),
        code: 'not_found',
        fallback: 'markdown',
      })
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
      return req.method === 'HEAD' ? res.status(status).end() : res.status(status).send(body)
    }
    if (!(error instanceof ConvertError)) console.error(error)
    return sendProblem(res, problemFrom(error, instance), accept, req.method)
  }
}

export default withServerEvents('browse', handler)
