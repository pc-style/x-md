/**
 * Fixed-window counters for request limiting.
 *
 * Backed by an Upstash/Vercel KV Redis REST endpoint when configured
 * (`KV_REST_API_URL`+`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN`),
 * so counts are shared across serverless instances. Falls back to a per-process
 * map otherwise, which still bounds a single warm instance.
 */

import { redisConfig, redisPipeline, type RedisCommand, type RedisConfig } from './redis.js'

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  /** Seconds until the window resets. */
  retryAfter: number
  /** Window bucket that was charged; pass to `refundRateLimit` to undo exactly that charge. */
  bucket: number
}

interface Store {
  /** Increment `key` inside a window of `windowSec`; return the new count. */
  incr(key: string, windowSec: number): Promise<number>
  /** Undo one increment (used when a dynamic-limit check rejects after counting). */
  decr(key: string): Promise<void>
  /** Read counts without touching them; missing keys read as 0. */
  mget(keys: string[]): Promise<number[]>
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
  async decr(key) {
    const entry = memory.get(key)
    if (entry) entry.count = Math.max(0, entry.count - 1)
  },
  async mget(keys) {
    const now = Date.now()
    return keys.map((key) => {
      const entry = memory.get(key)
      return entry && entry.resetAt > now ? entry.count : 0
    })
  },
}

function redisStore(config: RedisConfig): Store {
  const pipeline = <T,>(commands: RedisCommand[]) => redisPipeline<T>(config, commands)
  return {
    async incr(key, windowSec) {
      const data = await pipeline<number>([['INCR', key], ['EXPIRE', key, windowSec, 'NX']])
      const count = data[0]?.result
      if (typeof count !== 'number') throw new Error(data[0]?.error ?? 'rate limit store returned no count')
      return count
    },
    async decr(key) {
      await pipeline([['DECR', key]])
    },
    async mget(keys) {
      if (keys.length === 0) return []
      const data = await pipeline<Array<string | number | null>>([['MGET', ...keys]])
      if (data[0]?.error) throw new Error(data[0].error)
      return (data[0]?.result ?? []).map((value) => Number(value ?? 0) || 0)
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

/** Position inside the clock-aligned fixed window of `windowSec`. */
export function windowClock(windowSec: number, now = Date.now()): { bucket: number; elapsedSec: number; remainingSec: number } {
  const nowSec = Math.floor(now / 1000)
  const bucket = Math.floor(nowSec / windowSec)
  const elapsedSec = nowSec - bucket * windowSec
  return { bucket, elapsedSec, remainingSec: windowSec - elapsedSec }
}

const bucketKey = (key: string, bucket: number) => `rl:${key}:${bucket}`

/**
 * Count one hit for `key` and report whether it is within `limit` per `windowSec`.
 * Fixed windows are aligned to the clock so every instance agrees on the bucket.
 * Store failures fail open by default; scarce account capacity opts into fail-closed checks.
 * `refundOnReject` undoes the count when rejected, for limits that can grow later
 * in the same window (otherwise rejected retries would eat the capacity as it frees up).
 */
export async function rateLimit(key: string, limit: number, windowSec: number, failClosed = false, refundOnReject = false): Promise<RateLimitResult> {
  const { bucket, remainingSec: retryAfter } = windowClock(windowSec)
  const storeKey = bucketKey(key, bucket)
  let count: number
  try {
    // Keep counters for one extra window so the previous window stays readable via peekRateLimit.
    count = await store().incr(storeKey, 2 * windowSec + 1)
  } catch (error) {
    console.warn(`[ratelimit] store failure, ${failClosed ? 'blocking' : 'allowing'} request: ${String(error).slice(0, 120)}`)
    return { allowed: !failClosed, limit, remaining: failClosed ? 0 : limit, retryAfter, bucket }
  }
  const allowed = count <= limit
  if (!allowed && refundOnReject) await store().decr(storeKey).catch(() => undefined)
  return { allowed, limit, remaining: Math.max(0, limit - count), retryAfter, bucket }
}

/**
 * Give back one hit charged to `key` (best effort). Pass the `bucket` from the
 * charging call so a window rollover in between cannot decrement the wrong counter.
 */
export async function refundRateLimit(key: string, windowSec: number, bucket = windowClock(windowSec).bucket): Promise<void> {
  await store().decr(bucketKey(key, bucket)).catch(() => undefined)
}

/** Read current- and previous-window counts for several keys without charging them. */
export async function peekRateLimit(keys: string[], windowSec: number): Promise<{ current: number[]; previous: number[] }> {
  if (keys.length === 0) return { current: [], previous: [] }
  const { bucket } = windowClock(windowSec)
  const counts = await store().mget([...keys.map((k) => bucketKey(k, bucket)), ...keys.map((k) => bucketKey(k, bucket - 1))])
  return { current: counts.slice(0, keys.length), previous: counts.slice(keys.length) }
}

/** Best-effort client IP from Vercel/proxy headers. */
export function clientIp(headers: Record<string, string | string[] | undefined>): string {
  const pick = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim()
  return pick(headers['x-real-ip']) || pick(headers['x-forwarded-for']) || 'unknown'
}
