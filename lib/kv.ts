/**
 * Small general-purpose key/value + set store for durable app state (API keys).
 *
 * Backed by the shared Upstash/Vercel KV Redis REST client (`redis.ts`) when
 * configured; falls back to an in-process store otherwise (fine for local dev,
 * lost on restart). Kept separate from `ratelimit.ts`, which only needs
 * INCR/EXPIRE counters.
 */
import { redisConfig, redisConfigured, redisPipeline, type RedisCommand, type RedisConfig } from './redis.js'

export interface Kv {
  get(key: string): Promise<string | null>
  mget(keys: string[]): Promise<(string | null)[]>
  set(key: string, value: string): Promise<void>
  del(key: string): Promise<void>
  sadd(key: string, member: string): Promise<void>
  srem(key: string, member: string): Promise<void>
  smembers(key: string): Promise<string[]>
}

function redisKv(config: RedisConfig): Kv {
  async function command<T>(args: RedisCommand): Promise<T> {
    const data = await redisPipeline<T>(config, [args], 3000)
    if (data[0]?.error) throw new Error(data[0].error)
    return data[0]?.result as T
  }
  return {
    async get(key) {
      return (await command<string | null>(['GET', key])) ?? null
    },
    async mget(keys) {
      if (keys.length === 0) return []
      return ((await command<(string | null)[]>(['MGET', ...keys])) ?? []).map((v) => v ?? null)
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
    async mget(keys) {
      return keys.map((key) => strings.get(key) ?? null)
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
  return redisConfigured()
}

/** Test hook: drop the cached client so env changes take effect. */
export function resetKv(): void {
  cached = undefined
}
