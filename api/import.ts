import { withServerEvents } from '../lib/server-events.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem } from '../lib/apierror.js'
import { callerHeaders, keyRequirementFailure, resolveCaller } from '../lib/apiauth.js'
import { ConvertError } from '../lib/errors.js'
import { parseDateInput } from '../lib/fx-cursor.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { IMPORT_DEFAULT_CONCURRENCY, IMPORT_DEFAULT_MAX_POSTS, IMPORT_MAX_CONCURRENCY, IMPORT_MAX_POSTS } from '../lib/import.js'
import { historyPersistent, importWithHistory, readHistoryIndex } from '../lib/history.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota, type QuotaCaller } from '../lib/ratelimit-headers.js'
import { clientIp, rateLimit } from '../lib/ratelimit.js'
import { IMPORT_IP, IMPORT_KEY, importIpKey, importKeyKey, importKeyPolicy } from '../lib/quotas.js'
import { importAllowance } from '../lib/apikeys.js'
import { browseNotFoundDetail, notFoundResponse } from '../lib/notfound.js'

/**
 * `GET /:handle/posts` and `GET /api/v1/profiles/:handle/posts`: bulk profile
 * history as raw JSON. One request walks the whole requested range upstream in
 * parallel (lib/import.ts); `format=ndjson` streams posts as they arrive.
 */

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

/** A whole positive number no larger than `max`; anything else is `NaN` so the caller can reject it. */
function bounded(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^\d{1,9}$/.test(value)) return Number.NaN
  const parsed = Number.parseInt(value, 10)
  return parsed >= 1 && parsed <= max ? parsed : Number.NaN
}

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

  const importLimit = resolved.record ? importAllowance(resolved.record, IMPORT_KEY.quota) : IMPORT_KEY.quota
  const quotaCaller: QuotaCaller = resolved.caller.kind === 'key'
    ? { ip: resolved.ip, key: { id: resolved.caller.id, limit: resolved.caller.limit, importLimit } }
    : { ip: resolved.ip }
  const quota = await chargeRequestQuota('import', quotaCaller)
  applyRequestQuota(res, quota)
  if (!quota.allowed) {
    applyExhaustedQuota(res, quota, 'api-ip', quota.retryAfter)
    return sendProblem(res, problemDetails('rate_limited', { instance, detail: 'Too many requests from this address.', retryAfter: quota.retryAfter }), accept, req.method)
  }

  const handle = (param('handle') ?? '').replace(/^@/, '')
  const format = param('format') ?? 'json'
  const invalid = (detail: string) => sendProblem(res, problemDetails('invalid_option', { instance, detail }), accept, req.method)
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return sendProblem(res, problemDetails('invalid_handle', { instance, detail: 'A valid X handle is required.' }), accept, req.method)
  if (format !== 'json' && format !== 'ndjson') return invalid('`format` must be `json` or `ndjson`.')
  const since = parseDateInput(param('since'))
  const until = parseDateInput(param('until'))
  if (param('since') && !since) return invalid('`since` must be an ISO date, ISO datetime, or unix timestamp.')
  if (param('until') && !until) return invalid('`until` must be an ISO date, ISO datetime, or unix timestamp.')
  if (since && since.getTime() >= (until?.getTime() ?? Date.now())) return invalid('`since` must be earlier than `until`.')
  const maxPosts = bounded(param('max_posts') ?? param('limit'), IMPORT_MAX_POSTS)
  const concurrency = bounded(param('concurrency'), IMPORT_MAX_CONCURRENCY)
  if (Number.isNaN(maxPosts)) return invalid(`\`max_posts\` must be a whole number from 1 to ${IMPORT_MAX_POSTS}.`)
  if (Number.isNaN(concurrency)) return invalid(`\`concurrency\` must be a whole number from 1 to ${IMPORT_MAX_CONCURRENCY}.`)

  res.setHeader('Vary', 'Accept')
  res.setHeader('X-Source', 'fxtwitter')
  res.setHeader('Cache-Control', 'no-store')
  // HEAD learns the headers and the quota state; it neither reads the archive nor spends an import.
  if (req.method === 'HEAD') return res.status(200).end()

  // `index=true` answers from the archive index alone: what we already hold for this account.
  if (flag(param('index'), false)) {
    const archive = await readHistoryIndex(handle)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Archive-Store', historyPersistent() ? 'redis' : 'memory')
    return res.status(200).send(JSON.stringify({ handle, archive: archive ?? null, persistent: historyPersistent() }))
  }

  const options = {
    handle,
    since,
    until,
    maxPosts: maxPosts ?? IMPORT_DEFAULT_MAX_POSTS,
    concurrency: concurrency ?? IMPORT_DEFAULT_CONCURRENCY,
    withReplies: flag(param('with_replies'), true),
    withReposts: flag(param('with_reposts'), true),
    onlyReplies: flag(param('only_replies'), false),
    refresh: flag(param('refresh'), false),
  }

  // The import allowance is the deeper policy: spend one unit per walk.
  const allowance = resolved.caller.kind === 'key' ? importKeyPolicy(importLimit) : IMPORT_IP
  const counter = resolved.caller.kind === 'key' ? importKeyKey(resolved.caller.id) : importIpKey(resolved.ip)
  const verdict = await rateLimit(counter, allowance.quota, allowance.windowSec)
  if (!verdict.allowed) {
    applyExhaustedQuota(res, quota, allowance.name, verdict.retryAfter)
    return sendProblem(res, problemDetails('rate_limited', { instance, detail: `Too many bulk imports ${resolved.caller.kind === 'key' ? 'for this API key' : 'from this address'}: ${allowance.quota} per ${allowance.windowSec / 60} minutes.`, retryAfter: verdict.retryAfter }), accept, req.method)
  }

  // A client that leaves stops the walk instead of leaving up to 32 chains running.
  const aborter = new AbortController()
  res.once('close', () => aborter.abort())

  if (format === 'ndjson') {
    // Posts are streamed unsorted as the parallel chains deliver them; the
    // trailing `meta` line is the signal that the walk finished.
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    try {
      const result = await importWithHistory({ ...options, signal: aborter.signal, onPost: (post) => { res.write(`${JSON.stringify({ post })}\n`) } })
      res.write(`${JSON.stringify({ meta: result.meta, profile: result.profile })}\n`)
    } catch (error) {
      if (!(error instanceof ConvertError)) console.error(error)
      const problem = problemFrom(error, instance)
      res.write(`${JSON.stringify({ error: problem })}\n`)
    }
    return res.end()
  }

  try {
    const result = await importWithHistory({ ...options, signal: aborter.signal })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Result-Count', String(result.meta.count))
    res.setHeader('X-Import-Pages', String(result.meta.pages))
    res.setHeader('X-Archive-Served', String(result.meta.archive.served))
    res.setHeader('X-Archive-Store', historyPersistent() ? 'redis' : 'memory')
    return res.status(200).send(JSON.stringify(result))
  } catch (error) {
    if (error instanceof ConvertError && error.status === 404) {
      const { status, headers, body } = notFoundResponse({ instance, accept: 'application/json', detail: browseNotFoundDetail('profile', handle, error.message), code: 'not_found', fallback: 'json' })
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      return res.status(status).send(body)
    }
    if (!(error instanceof ConvertError)) console.error(error)
    return sendProblem(res, problemFrom(error, instance), accept, req.method)
  }
}

export default withServerEvents('import', handler)
