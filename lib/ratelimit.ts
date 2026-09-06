/**
 * Fixed-window counters for request limiting.
 *
 * Backed by an Upstash/Vercel KV Redis REST endpoint when configured
 * (`KV_REST_API_URL`+`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN`),
 * so counts are shared across serverless instances. Falls back to a per-process
 * map otherwise, which still bounds a single warm instance.
 */

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until the window resets. */
  retryAfter: number
}

interface Store {
  /** Increment `key` inside a window of `windowSec`; return the new count. */
  incr(key: string, windowSec: number): Promise<number>
}

const memory = new Map<string, { count: number; resetAt: number }>()

const memoryStore: Store = {
  async incr(key, windowSec) {
    const now = Date.now()
    const entry = memory.get(key)
    if (!entry || entry.resetAt <= now) {
      memory.set(key, { count: 1, resetAt: now + windowSec * 1000 })
      if (memory.size > 5000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k)
      return 1
    }
    entry.count += 1
    return entry.count
  },
}

function redisConfig(): { url: string; token: string } | undefined {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : undefined
}

function redisStore(config: { url: string; token: string }): Store {
  return {
    async incr(key, windowSec) {
      const response = await fetch(`${config.url}/pipeline`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify([['INCR', key], ['EXPIRE', key, windowSec, 'NX']]),
        signal: AbortSignal.timeout(2000),
      })
      if (!response.ok) throw new Error(`rate limit store HTTP ${response.status}`)
      const data = (await response.json()) as Array<{ result?: number; error?: string }>
      const count = data[0]?.result
      if (typeof count !== 'number') throw new Error(data[0]?.error ?? 'rate limit store returned no count')
      return count
    },
  }
}

function store(): Store {
  const config = redisConfig()
  return config ? redisStore(config) : memoryStore
}

/** Test hook. */
export function resetRateLimits(): void {
  memory.clear()
}

/**
 * Count one hit for `key` and report whether it is within `limit` per `windowSec`.
 * Fixed windows are aligned to the clock so every instance agrees on the bucket.
 * Store failures fail open by default; scarce account capacity opts into fail-closed checks.
 */
export async function rateLimit(key: string, limit: number, windowSec: number, failClosed = false): Promise<RateLimitResult> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec)
  const retryAfter = (bucket + 1) * windowSec - Math.floor(Date.now() / 1000)
  let count: number
  try {
    count = await store().incr(`rl:${key}:${bucket}`, windowSec + 1)
  } catch (error) {
    console.warn(`[ratelimit] store failure, ${failClosed ? 'blocking' : 'allowing'} request: ${String(error).slice(0, 120)}`)
    return { allowed: !failClosed, limit, remaining: failClosed ? 0 : limit, retryAfter }
  }
  return { allowed: count <= limit, limit, remaining: Math.max(0, limit - count), retryAfter }
}

/** Best-effort client IP from Vercel/proxy headers. */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const pick = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim()
  return pick(headers['x-real-ip']) || pick(headers['x-forwarded-for']) || 'unknown'
}
