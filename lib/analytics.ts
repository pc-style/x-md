import { notedErrorCode, notedErrorType, requestBatch, serverEvent } from './server-events.js'
import { createHmac } from 'node:crypto'
import { clientIp } from './ratelimit.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'

type Endpoint = 'convert' | 'browse' | 'import' | 'oembed' | 'mcp' | 'index' | 'notfound'

/** Only a verified, internal key ID may be assigned here. Never a bearer token. */
interface RequestIdentity {
  keyId?: string
}

/**
 * Anonymous callers are counted per UTC day: an HMAC of the IP under a salt that
 * changes daily and derives from a server-only secret, so the ID can't be reversed
 * or linked across days. Without a secret or an IP there is no ID.
 */
function dailyCallerId(req: IncomingMessage): string | null {
  const secret = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  const ip = clientIp(req.headers)
  if (!secret || ip === 'unknown') return null
  const salt = createHmac('sha256', secret).update(`xmd-caller-id:${new Date().toISOString().slice(0, 10)}`).digest()
  return `ip:${createHmac('sha256', salt).update(ip).digest('hex').slice(0, 32)}`
}

/**
 * One personless event per completed production function response. Explicit
 * fields only: never serialize the request, URL, headers, body, or errors.
 * CDN hits don't invoke the function and are intentionally not counted.
 */
export function trackRequest(
  req: IncomingMessage,
  res: ServerResponse,
  endpoint: Endpoint,
  resource?: unknown,
): RequestIdentity {
  const identity: RequestIdentity = {}
  const token = process.env.POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
  const host = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST
  if (process.env.VERCEL_ENV !== 'production' || !token || !host?.startsWith('https://') || req.method === 'OPTIONS') return identity

  const started = performance.now()
  const send = requestBatch()
  const route = endpoint === 'browse' && ['profile', 'search', 'followers', 'following'].includes(String(resource))
    ? String(resource) : endpoint
  const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') ? req.method : 'OTHER'

  /**
   * How the caller authenticated, as the response reports it. Read at finish
   * time by both events: a failure rate is only readable per caller class if
   * `request_failed` carries the same dimension `request_completed` does.
   */
  function keyStatus(): 'valid' | 'invalid' | 'unverified' | 'anonymous' {
    const header = res.getHeader('X-Api-Key-Status')
    return header === 'valid' || header === 'invalid' || header === 'unverified' ? header : 'anonymous'
  }

  // Register before returning the response so Vercel keeps the send alive.
  // A disconnected request without a completed response isn't counted.
  waitUntil(new Promise<void>((resolve) => {
    const onClose = () => { res.off('finish', onFinish); resolve() }
    const onFinish = () => {
      res.off('close', onClose)
      const status = res.statusCode
      const auth = keyStatus()
      const access = auth === 'valid' ? 'key' : 'public'
      const duration_ms = Math.max(0, Math.round(performance.now() - started))
      const cacheHeader = res.getHeader('X-Cache')
      const cache = cacheHeader === 'HIT' ? 'hit' : cacheHeader === 'MISS' ? 'miss' : cacheHeader === 'BYPASS' ? 'bypass' : 'unknown'
      // Public callers share one ID: no person profiles are made, so it carries no
      // identity, and PostHog doesn't count every request as a new user.
      const keyId = auth === 'valid' && identity.keyId
        ? `key:${createHmac('sha256', token!).update(identity.keyId).digest('hex')}`
        : null
      const batch = [serverEvent('request_completed', {
        route, method: method ?? 'OTHER', status, duration_ms, cache, access, key_status: auth,
        // A property, not the person: counts unique callers without building profiles.
        caller_id: keyId ?? dailyCallerId(req),
        degraded: res.getHeader('X-Search-Degraded') === 'true',
      }, keyId ?? 'anonymous')]
      if (status >= 400) batch.push(serverEvent('request_failed', {
        route, status, error_type: notedErrorType(res, status), error_code: notedErrorCode(res), duration_ms, access, key_status: auth,
      }))
      void send(batch).finally(resolve)
    }
    res.once('finish', onFinish)
    res.once('close', onClose)
  }))
  return identity
}
