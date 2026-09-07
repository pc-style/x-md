/**
 * Shared Upstash/Vercel KV Redis REST client used by the rate limiter and the
 * KV store, so URL/token selection and pipeline handling cannot drift.
 *
 * Accepts either complete pair: `KV_REST_API_URL`+`KV_REST_API_TOKEN` (Vercel
 * KV / marketplace integration) or `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN`.
 * A pair is only used when both halves are present, and the URL must be HTTPS
 * because the token travels in the Authorization header.
 */

export interface RedisConfig {
  url: string
  token: string
}

export type RedisCommand = (string | number)[]
export interface RedisReply<T = unknown> {
  result?: T
  error?: string
}

function pair(urlName: string, tokenName: string): RedisConfig | undefined {
  const url = process.env[urlName]
  const token = process.env[tokenName]
  if (!url || !token) return undefined
  if (!/^https:\/\//i.test(url)) {
    console.warn(`[redis] ignoring ${urlName}: must be an https:// URL`)
    return undefined
  }
  return { url: url.replace(/\/+$/, ''), token }
}

export function redisConfig(): RedisConfig | undefined {
  return pair('KV_REST_API_URL', 'KV_REST_API_TOKEN') ?? pair('UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN')
}

/** Whether a shared (durable, cross-instance) Redis is configured. */
export function redisConfigured(): boolean {
  return redisConfig() !== undefined
}

/** Run commands through the REST pipeline endpoint; one reply per command, in order. */
export async function redisPipeline<T = unknown>(config: RedisConfig, commands: RedisCommand[], timeoutMs = 2000): Promise<RedisReply<T>[]> {
  const response = await fetch(`${config.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`redis HTTP ${response.status}`)
  return (await response.json()) as RedisReply<T>[]
}
