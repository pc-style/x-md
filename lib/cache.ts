import { trackCache } from './server-events.js'
import { redisConfig, redisPipeline } from './redis.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type CacheStatus = 'hit' | 'miss' | 'bypass'

interface CacheEnvelope<T> {
  value: T
  expiresAt: number
  storedAt: number
}

const memory = new Map<string, CacheEnvelope<unknown>>()
const MAX_MEMORY_ENTRIES = 500
const lookups = new Map<string, Promise<unknown>>()
const fills = new Map<string, Promise<unknown>>()

/** Share only pending work; settled misses and failures must be retried. */
async function singleFlight<T>(pending: Map<string, Promise<unknown>>, key: string, fn: (release: () => void) => Promise<T>): Promise<T> {
  const existing = pending.get(key)
  if (existing) return existing as Promise<T>
  // Keep unique-key bursts bounded without evicting work other callers await.
  if (pending.size >= MAX_MEMORY_ENTRIES) return fn(() => {})
  let operation: Promise<T> | undefined
  const release = () => {
    if (operation && pending.get(key) === operation) pending.delete(key)
  }
  operation = fn(release)
  pending.set(key, operation)
  try {
    return await operation
  } finally {
    release()
  }
}

function ttlMs(): number {
  const raw = process.env.CACHE_TTL_SECONDS ?? '3600'
  const seconds = Number.parseInt(raw, 10)
  if (!Number.isFinite(seconds) || seconds <= 0) return 3600_000
  return seconds * 1000
}

function cacheDisabled(): boolean {
  return process.env.CACHE_DISABLED === '1' || process.env.CACHE_DISABLED === 'true'
}

function diskCacheEnabled(): boolean {
  if (process.env.VERCEL) return false
  if (process.env.CACHE_PERSIST === '0' || process.env.CACHE_PERSIST === 'false') return false
  return true
}

function cacheDir(): string {
  return process.env.CACHE_DIR ?? path.join(process.cwd(), '.cache', 'conversions')
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

function touchMemory<T>(key: string, entry: CacheEnvelope<T>): void {
  memory.delete(key)
  memory.set(key, entry)
}

function pruneMemory(): void {
  while (memory.size > MAX_MEMORY_ENTRIES) {
    const oldest = memory.keys().next().value
    if (oldest === undefined) break
    memory.delete(oldest)
  }
}

function readEnvelope<T>(entry: CacheEnvelope<T> | undefined): T | undefined {
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) return undefined
  return entry.value
}

function readMemory<T>(key: string): { value: T; status: 'hit' } | undefined {
  const entry = memory.get(key) as CacheEnvelope<T> | undefined
  const value = readEnvelope(entry)
  if (entry && value !== undefined) {
    touchMemory(key, entry)
    return { value, status: 'hit' }
  }
  memory.delete(key)
  return undefined
}

/**
 * `JSON.parse` only proves the bytes were JSON. A durable entry can predate a
 * shape change or be written by something else, and a non-numeric `expiresAt`
 * would read as unexpired forever, so reject anything that is not an envelope.
 */
function parseEnvelope<T>(raw: string): CacheEnvelope<T> | undefined {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') return undefined
  const entry = parsed as Partial<CacheEnvelope<T>>
  if (!('value' in entry)) return undefined
  if (!isTimestamp(entry.storedAt) || !isTimestamp(entry.expiresAt)) return undefined
  return entry as CacheEnvelope<T>
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

async function readDisk<T>(key: string): Promise<CacheEnvelope<T> | undefined> {
  if (!diskCacheEnabled()) return undefined
  try {
    const file = path.join(cacheDir(), `${hashKey(key)}.json`)
    const raw = await readFile(file, 'utf8')
    return parseEnvelope<T>(raw)
  } catch {
    return undefined
  }
}

async function writeDisk<T>(key: string, entry: CacheEnvelope<T>): Promise<void> {
  if (!diskCacheEnabled()) return
  try {
    const dir = cacheDir()
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${hashKey(key)}.json`)
    await writeFile(file, JSON.stringify(entry), 'utf8')
  } catch {
    // Best-effort disk cache for local dev.
  }
}

/**
 * Shared cross-instance layer over the same Upstash/Vercel KV Redis the rate
 * limiter uses. Serverless instances do not share the in-process `memory` map,
 * so without this every isolated instance repeats upstream work on a cold key.
 * Best-effort: a store failure leaves the request to fall through to the origin.
 */
function sharedKey(key: string): string {
  return `cache:${hashKey(key)}`
}

async function readShared<T>(key: string): Promise<CacheEnvelope<T> | undefined> {
  const config = redisConfig()
  if (!config) return undefined
  try {
    const data = await redisPipeline<string | null>(config, [['GET', sharedKey(key)]], 3000)
    if (data[0]?.error) throw new Error(data[0].error)
    const raw = data[0]?.result
    if (!raw) return undefined
    return parseEnvelope<T>(raw)
  } catch (error) {
    console.warn(`[cache] shared read failed: ${String(error).slice(0, 120)}`)
    return undefined
  }
}

async function writeShared<T>(key: string, entry: CacheEnvelope<T>, ttl: number): Promise<void> {
  const config = redisConfig()
  if (!config) return
  const seconds = Math.max(1, Math.ceil(ttl / 1000))
  try {
    const data = await redisPipeline(config, [['SET', sharedKey(key), JSON.stringify(entry), 'EX', seconds]], 3000)
    if (data[0]?.error) throw new Error(data[0].error)
  } catch (error) {
    console.warn(`[cache] shared write failed: ${String(error).slice(0, 120)}`)
  }
}

/** Test hook: drop the in-process hot layer to simulate a fresh runtime instance. */
export function resetMemoryCache(): void {
  memory.clear()
  lookups.clear()
  fills.clear()
}

export function buildCacheKey(parts: Record<string, string | number>): string {
  return Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export async function getCached<T>(key: string): Promise<{ value: T; status: CacheStatus } | undefined> {
  const mem = readMemory<T>(key)
  if (mem) return mem

  return singleFlight(lookups, key, async () => {
    const shared = await readShared<T>(key)
    const fromShared = readEnvelope(shared)
    if (fromShared !== undefined && shared) {
      touchMemory(key, shared)
      pruneMemory()
      return { value: fromShared, status: 'hit' as const }
    }

    const disk = await readDisk<T>(key)
    const fromDisk = readEnvelope(disk)
    if (fromDisk !== undefined && disk) {
      touchMemory(key, disk)
      pruneMemory()
      return { value: fromDisk, status: 'hit' as const }
    }

    return undefined
  })
}

export async function setCached<T>(key: string, value: T, ttl = ttlMs()): Promise<void> {
  const entry: CacheEnvelope<T> = {
    value,
    storedAt: Date.now(),
    expiresAt: Date.now() + ttl,
  }

  touchMemory(key, entry)
  pruneMemory()
  // Both durable writes are best-effort; run them together so a miss does not
  // pay for the Redis round trip and the disk write back to back.
  await Promise.all([writeShared(key, entry, ttl), writeDisk(key, entry)])
}

export interface WithCacheOptions {
  /**
   * Settles once the caller may be answered: served, charged deeper, or sent
   * to the origin. The lookup runs while it is pending, since a lookup commits
   * nothing, and a rejection is propagated untouched before any of those.
   */
  admission?: Promise<unknown>
  /**
   * Takes over the durable write after a miss, so the caller is answered as
   * soon as hot memory holds the value. Without it the write is awaited.
   */
  defer?: (write: Promise<void>) => void
}

/**
 * `ttlFor` lets a caller shorten the TTL based on the produced value, e.g. a
 * degraded fallback result that should be re-checked soon.
 * `flightKey` scopes pending origin work when the loader performs per-caller
 * admission. Stored entries and their durable lookups still use the shared key.
 */
export async function withCache<T>(
  key: string,
  nocache: boolean,
  fn: () => Promise<T>,
  ttlFor?: (value: T) => number | undefined,
  flightKey?: string,
  options: WithCacheOptions = {},
): Promise<{ value: T; status: CacheStatus }> {
  const { admission, defer } = options
  if (nocache || cacheDisabled()) {
    if (admission) await admission
    return { value: await fn(), status: 'bypass' }
  }

  const hot = readMemory<T>(key)
  if (hot) {
    if (admission) await admission
    trackCache(true)
    return hot
  }

  const fillKey = JSON.stringify([key, flightKey ?? null])
  const pending = fills.get(fillKey)
  if (pending) {
    if (admission) await admission
    trackCache(false)
    return { value: await pending as T, status: 'miss' }
  }

  let hit = await getCached<T>(key)
  if (admission) {
    await admission
    // Another caller's fill may have landed while the verdict was pending.
    hit ??= readMemory<T>(key)
  }
  trackCache(Boolean(hit))
  if (hit) return hit

  const value = await singleFlight(fills, fillKey, async (release) => {
    const value = await fn()
    const write = setCached(key, value, ttlFor?.(value) ?? ttlMs())
    // setCached publishes hot memory synchronously. New callers must read its
    // expiry instead of joining this value while a slow durable write finishes.
    release()
    if (defer) defer(write)
    else await write
    return value
  })
  return { value, status: 'miss' }
}

export function cacheControlHeader(): string {
  return 'public, max-age=0, must-revalidate'
}

export function vercelCacheControlHeader(ttlSeconds?: number): string {
  if (ttlSeconds === undefined) {
    return `public, s-maxage=${Math.floor(ttlMs() / 1000)}, stale-while-revalidate=86400`
  }
  return `public, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 4}`
}
