import { createHmac, randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { waitUntil } from '@vercel/functions'

type Endpoint = 'convert' | 'browse' | 'oembed'

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

  async function send() {
    try {
      const cacheHeader = res.getHeader('X-Cache')
      const cache = cacheHeader === 'HIT' ? 'hit' : cacheHeader === 'MISS' ? 'miss' : cacheHeader === 'BYPASS' ? 'bypass' : 'unknown'
      const keyStatus = res.getHeader('X-Api-Key-Status')
      const auth = keyStatus === 'valid' || keyStatus === 'invalid' || keyStatus === 'unverified' ? keyStatus : 'anonymous'
      const uuid = randomUUID()
      const response = await fetch(`${host!.replace(/\/$/, '')}/i/v0/e/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          api_key: token,
          event: 'request_completed',
          uuid,
          distinct_id: auth === 'valid' && identity.keyId
            ? `key:${createHmac('sha256', token!).update(identity.keyId).digest('hex')}`
            : `anonymous:${uuid}`,
          timestamp: new Date().toISOString(),
          properties: {
            route,
            method,
            status: res.statusCode,
            duration_ms: Math.max(0, Math.round(performance.now() - started)),
            cache,
            access: auth === 'valid' ? 'key' : 'public',
            key_status: auth,
            degraded: res.getHeader('X-Search-Degraded') === 'true',
            environment: 'production',
            $process_person_profile: false,
            $geoip_disable: true,
            $ip: null,
          },
        }),
      })
      if (!response.ok) console.warn('[analytics] PostHog rejected an event')
    } catch {
      // Analytics must never change an API response or log request details.
      console.warn('[analytics] PostHog event delivery failed')
    }
  }

  // Register before returning the response so Vercel keeps the send alive.
  // A disconnected request without a completed response isn't counted.
  waitUntil(new Promise<void>((resolve) => {
    const onClose = () => { res.off('finish', onFinish); resolve() }
    const onFinish = () => { res.off('close', onClose); void send().finally(resolve) }
    res.once('finish', onFinish)
    res.once('close', onClose)
  }))
  return identity
}
