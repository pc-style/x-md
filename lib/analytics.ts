import { notedErrorCode, notedErrorType, sendServerEvents, serverEvent } from './server-events.js'
import { createHmac } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'

type Endpoint = 'convert' | 'browse' | 'import' | 'oembed' | 'mcp' | 'index' | 'notfound'

/** Only a verified, internal key ID may be assigned here. Never a bearer token. */
interface RequestIdentity {
  keyId?: string
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
      const distinctId = auth === 'valid' && identity.keyId
        ? `key:${createHmac('sha256', token!).update(identity.keyId).digest('hex')}`
        : 'anonymous'
      const batch = [serverEvent('request_completed', {
        route, method: method ?? 'OTHER', status, duration_ms, cache, access, key_status: auth,
        degraded: res.getHeader('X-Search-Degraded') === 'true',
      }, distinctId)]
      if (status >= 400) batch.push(serverEvent('request_failed', {
        route, status, error_type: notedErrorType(res, status), error_code: notedErrorCode(res), duration_ms, access, key_status: auth,
      }))
      void sendServerEvents(batch).finally(resolve)
    }
    res.once('finish', onFinish)
    res.once('close', onClose)
  }))
  return identity
}
