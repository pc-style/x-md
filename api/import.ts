import { withServerEvents } from '../lib/server-events.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { problemDetails, problemFrom, requestInstance, sendProblem } from '../lib/apierror.js'
import { callerHeaders, resolveCaller } from '../lib/apiauth.js'
import { ConvertError } from '../lib/errors.js'
import { parseDateInput } from '../lib/fx-cursor.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'
import { importProfilePosts, IMPORT_DEFAULT_CONCURRENCY, IMPORT_DEFAULT_MAX_POSTS, IMPORT_MAX_CONCURRENCY, IMPORT_MAX_POSTS } from '../lib/import.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota, type QuotaCaller } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
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

function integer(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

async function handler(req: VercelRequest, res: VercelResponse) {
  const identity = trackRequest(req, res, 'import', 'posts')
  setCorsHeaders(res)
  applyQuotaPolicyOnly(res, 'read', { ip: clientIp(req.headers) })
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

  const quotaCaller: QuotaCaller = resolved.caller.kind === 'key'
    ? { ip: resolved.ip, key: { id: resolved.caller.id, limit: resolved.caller.limit } }
    : { ip: resolved.ip }
  const quota = await chargeRequestQuota('read', quotaCaller)
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
  const maxPosts = integer(param('max_posts') ?? param('limit'))
  const concurrency = integer(param('concurrency'))
  if (Number.isNaN(maxPosts) || (maxPosts !== undefined && maxPosts <= 0)) return invalid(`\`max_posts\` must be a positive integer up to ${IMPORT_MAX_POSTS}.`)
  if (Number.isNaN(concurrency) || (concurrency !== undefined && concurrency <= 0)) return invalid(`\`concurrency\` must be a positive integer up to ${IMPORT_MAX_CONCURRENCY}.`)

  const options = {
    handle,
    since,
    until,
    maxPosts: maxPosts ?? IMPORT_DEFAULT_MAX_POSTS,
    concurrency: concurrency ?? IMPORT_DEFAULT_CONCURRENCY,
    withReplies: flag(param('with_replies'), true),
    withReposts: flag(param('with_reposts'), true),
    onlyReplies: flag(param('only_replies'), false),
  }

  // A client that leaves stops the walk instead of leaving up to 32 chains running.
  const aborter = new AbortController()
  res.once('close', () => aborter.abort())
  res.setHeader('Vary', 'Accept')
  res.setHeader('X-Source', 'fxtwitter')
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'HEAD') return res.status(200).end()

  if (format === 'ndjson') {
    // Posts are streamed unsorted as the parallel chains deliver them; the
    // trailing `meta` line is the signal that the walk finished.
    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    try {
      const result = await importProfilePosts({ ...options, signal: aborter.signal, onPost: (post) => { res.write(`${JSON.stringify({ post })}\n`) } })
      res.write(`${JSON.stringify({ meta: result.meta, profile: result.profile })}\n`)
    } catch (error) {
      if (!(error instanceof ConvertError)) console.error(error)
      const problem = problemFrom(error, instance)
      res.write(`${JSON.stringify({ error: problem })}\n`)
    }
    return res.end()
  }

  try {
    const result = await importProfilePosts({ ...options, signal: aborter.signal })
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('X-Result-Count', String(result.meta.count))
    res.setHeader('X-Import-Pages', String(result.meta.pages))
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
