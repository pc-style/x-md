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
  if (Date.now() > entry.expiresAt) return undefined
  return entry.value
}

async function readDisk<T>(key: string): Promise<CacheEnvelope<T> | undefined> {
  if (!diskCacheEnabled()) return undefined
  try {
    const file = path.join(cacheDir(), `${hashKey(key)}.json`)
    const raw = await readFile(file, 'utf8')
    return JSON.parse(raw) as CacheEnvelope<T>
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

export function buildCacheKey(parts: Record<string, string | number>): string {
  return Object.entries(parts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
}

export async function getCached<T>(key: string): Promise<{ value: T; status: CacheStatus } | undefined> {
  const mem = readEnvelope(memory.get(key) as CacheEnvelope<T> | undefined)
  if (mem !== undefined) {
    touchMemory(key, memory.get(key) as CacheEnvelope<T>)
    return { value: mem, status: 'hit' }
  }

  const disk = await readDisk<T>(key)
  const fromDisk = readEnvelope(disk)
  if (fromDisk !== undefined && disk) {
    touchMemory(key, disk)
    return { value: fromDisk, status: 'hit' }
  }

  return undefined
}

export async function setCached<T>(key: string, value: T): Promise<void> {
  const entry: CacheEnvelope<T> = {
    value,
    storedAt: Date.now(),
    expiresAt: Date.now() + ttlMs(),
  }

  touchMemory(key, entry)
  pruneMemory()
  await writeDisk(key, entry)
}

export async function withCache<T>(
  key: string,
  nocache: boolean,
  fn: () => Promise<T>,
): Promise<{ value: T; status: CacheStatus }> {
  if (nocache || cacheDisabled()) {
    return { value: await fn(), status: 'bypass' }
  }

  const hit = await getCached<T>(key)
  if (hit) return hit

  const value = await fn()
  await setCached(key, value)
  return { value, status: 'miss' }
}

export function cacheControlHeader(): string {
  const seconds = Math.floor(ttlMs() / 1000)
  return `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=86400`
}
