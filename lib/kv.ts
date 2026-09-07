/**
 * Small general-purpose key/value + set store for durable app state (API keys).
 *
 * Backed by the same Upstash/Vercel KV Redis REST endpoint as the rate limiter
 * when configured; falls back to an in-process store otherwise (fine for local
 * dev, lost on restart). Kept separate from `ratelimit.ts`, which only needs
 * INCR/EXPIRE counters.
 */

export interface Kv {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  sadd(key: string, member: string): Promise<void>
  srem(key: string, member: string): Promise<void>
  smembers(key: string): Promise<string[]>
}

function redisConfig(): { url: string; token: string } | undefined {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : undefined
}

function redisKv(config: { url: string; token: string }): Kv {
  async function command<T>(args: (string | number)[]): Promise<T> {
    const response = await fetch(`${config.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([args]),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error(`kv store HTTP ${response.status}`)
    const data = (await response.json()) as Array<{ result?: T; error?: string }>
    if (data[0]?.error) throw new Error(data[0].error)
    return data[0]?.result as T
  }
  return {
    async get(key) {
      return (await command<string | null>(['GET', key])) ?? null
    },
    async set(key, value) {
      await command(['SET', key, value])
    },
    async del(key) {
      await command(['DEL', key])
    },
    async sadd(key, member) {
      await command(['SADD', key, member])
    },
    async srem(key, member) {
      await command(['SREM', key, member])
    },
    async smembers(key) {
      return (await command<string[]>(['SMEMBERS', key])) ?? []
    },
  }
}

function memoryKv(): Kv {
  const strings = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  return {
    async get(key) {
      return strings.get(key) ?? null
    },
    async set(key, value) {
      strings.set(key, value)
    },
    async del(key) {
      strings.delete(key)
      sets.delete(key)
    },
    async sadd(key, member) {
      const set = sets.get(key) ?? new Set<string>()
      set.add(member)
      sets.set(key, set)
    },
    async srem(key, member) {
      sets.get(key)?.delete(member)
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])]
    },
  }
}

let cached: Kv | undefined

export function kv(): Kv {
  if (cached) return cached
  const config = redisConfig()
  cached = config ? redisKv(config) : memoryKv()
  return cached
}

/** Whether a shared (durable, cross-instance) store is configured. */
export function kvDurable(): boolean {
  return redisConfig() !== undefined
}

/** Test hook: drop the cached client so env changes take effect. */
export function resetKv(): void {
  cached = undefined
}
