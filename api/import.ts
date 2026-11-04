import { withServerEvents } from '../lib/server-events.js'
import { withErrorTracking } from '../lib/error-tracking.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem, streamProblemFrom } from '../lib/apierror.js'
import { callerHeaders, keyRequirementFailure, quotaCaller as quotaCallerOf, resolveCaller } from '../lib/apiauth.js'
import { ConvertError } from '../lib/errors.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { historyPersistent, readHistoryIndex } from '../lib/history.js'
import { chargeImport, parseImportRequest, runImport } from '../lib/import-request.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota, settleRequestQuota } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import { browseNotFoundDetail, notFoundResponse } from '../lib/notfound.js'

/**
 * `GET /:handle/posts` and `GET /api/v1/profiles/:handle/posts`: bulk profile
 * history as raw JSON. One request walks the whole requested range upstream in
 * parallel (lib/import.ts); `format=ndjson` emits the final selected posts followed by metadata.
 */

async function handler(req: VercelRequest, res: VercelResponse) {
  const identity = trackRequest(req, res, 'import', 'posts')
  setCorsHeaders(res)
  applyQuotaPolicyOnly(res, 'import', { ip: clientIp(req.headers) })
  if (req.method === 'OPTIONS') return res.status(204).end()

  const param = (key: string): string | undefined => typeof req.query[key] === 'string' ? req.query[key] : undefined
  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, requestOrigin(req))

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    return sendProblem(res, problemDetails('method_not_allowed', { instance, detail: `${req.method} is not supported on this route. x.md only reads public X content.` }), accept, req.method)
  }

  const resolved = await resolveCaller(req.headers)
  if (resolved.status === 'valid' && resolved.caller.kind === 'key') identity.keyId = resolved.caller.id
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  if (resolved.status === 'invalid') {
    return sendProblem(res, problemDetails('invalid_key', { instance, detail: 'Invalid or disabled API key.' }), accept, req.method)
  }
  const keyFailure = keyRequirementFailure(resolved)
  if (keyFailure) return sendProblem(res, problemDetails('unauthorized', { instance, detail: keyFailure }), accept, req.method)

  const quotaCaller = quotaCallerOf(resolved)
  const quota = await chargeRequestQuota('import', quotaCaller)
  applyRequestQuota(res, quota)
  if (!quota.allowed) {
    applyExhaustedQuota(res, quota, 'api-ip', quota.retryAfter)
    return sendProblem(res, problemDetails('rate_limited', { instance, detail: 'Too many requests from this address.', retryAfter: quota.retryAfter }), accept, req.method)
  }

  const format = param('format') ?? 'json'
  const parsed = parseImportRequest(param)
  if (!parsed.ok && parsed.code === 'invalid_handle') return sendProblem(res, problemDetails('invalid_handle', { instance, detail: parsed.detail }), accept, req.method)
  if (format !== 'json' && format !== 'ndjson') return sendProblem(res, problemDetails('invalid_option', { instance, detail: '`format` must be `json` or `ndjson`.' }), accept, req.method)
  if (!parsed.ok) return sendProblem(res, problemDetails(parsed.code, { instance, detail: parsed.detail }), accept, req.method)
  const { options } = parsed

  res.setHeader('Vary', 'Accept')
  res.setHeader('X-Source', 'fxtwitter')
  res.setHeader('Cache-Control', 'no-store')
  // HEAD learns the headers and the quota state; it neither reads the archive nor spends an import.
  if (req.method === 'HEAD') return res.status(200).end()

  // `index=true` answers from the archive index alone: what we already hold for this account.
  if (param('index') === 'true' || param('index') === '1') {
    const archive = await readHistoryIndex(options.handle)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Archive-Store', historyPersistent() ? 'redis' : 'memory')
    return res.status(200).send(JSON.stringify({ handle: options.handle, archive: archive ?? null, persistent: historyPersistent() }))
  }

  // The import allowance is the deeper policy: spend one unit per walk.
  const charged = await chargeImport(quotaCaller)
  if ('refused' in charged) {
    applyExhaustedQuota(res, quota, charged.refused.policy, charged.refused.retryAfter ?? 1)
    return sendProblem(res, problemDetails('rate_limited', { instance, detail: charged.refused.message, retryAfter: charged.refused.retryAfter }), accept, req.method)
  }
  applyRequestQuota(res, await settleRequestQuota(quota, 'import', quotaCaller))

  // A client that leaves stops the walk instead of leaving up to 32 chains running.
  const aborter = new AbortController()
  res.once('close', () => aborter.abort())

  if (format === 'ndjson') {
    // Emit the final selection so NDJSON and JSON agree. The trailing meta
    // line is required to distinguish completion from a broken connection.
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    let streamedPosts = 0
    try {
      const result = await runImport(options, quotaCaller, charged.charge, { signal: aborter.signal, onPost: (post) => { streamedPosts += 1; res.write(`${JSON.stringify({ post })}\n`) } })
      res.write(`${JSON.stringify({ meta: result.meta, profile: result.profile })}\n`)
    } catch (error) {
      if (!(error instanceof ConvertError)) console.error(error)
      const problem = streamProblemFrom(error, instance, streamedPosts)
      res.write(`${JSON.stringify({ error: problem })}\n`)
    }
    return res.end()
  }

  try {
    const result = await runImport(options, quotaCaller, charged.charge, { signal: aborter.signal })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Result-Count', String(result.meta.count))
    res.setHeader('X-Import-Pages', String(result.meta.pages))
    res.setHeader('X-Archive-Served', String(result.meta.archive.served))
    res.setHeader('X-Archive-Store', historyPersistent() ? 'redis' : 'memory')
    return res.status(200).send(JSON.stringify(result))
  } catch (error) {
    // A busy refusal gave its import back; republish the counters so the headers show it.
    if (error instanceof ConvertError && error.code === 'import_busy') applyRequestQuota(res, await settleRequestQuota(quota, 'import', quotaCaller))
    if (error instanceof ConvertError && error.status === 404) {
      const { status, headers, body } = notFoundResponse({ instance, accept: 'application/json', detail: browseNotFoundDetail('profile', options.handle, error.message), code: 'not_found', fallback: 'json' })
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      return res.status(status).send(body)
    }
    if (!(error instanceof ConvertError)) console.error(error)
    return sendProblem(res, problemFrom(error, instance), accept, req.method)
  }
}

export default withErrorTracking(withServerEvents('import', handler))
