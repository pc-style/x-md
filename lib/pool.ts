/**
 * Dynamic sharing of the account-backed search pool between API keys and the public.
 *
 * Every key is assigned an allowance per 15-minute window. Instead of carving
 * that out of the pool permanently, we *reserve* only what a key is predicted to
 * still use in the current window, and let the rest flow to anonymous callers:
 *
 *   publicCap = poolCapacity − Σ used_by_keys − Σ reserved_for_keys
 *
 * A key's reservation is its remaining allowance, shrunk when
 *   - the key is disabled or has been idle for `idleReleaseMinutes` → 0
 *   - the window is running out and its recent pace says it will not spend the
 *     rest → held amount decays linearly toward zero at the window boundary,
 *     unless the observed request rate (this or the previous window) projects
 *     higher, in which case we hold twice that projection.
 *
 * The key itself is still limited only by its own allowance, so in the worst
 * case a friend who goes quiet and then bursts late in a window may find part
 * of their slice already handed to the public. That is the accepted trade-off.
 */
import { listApiKeys, type ApiKeyRecord } from './apikeys.js'
import { kv } from './kv.js'
import { peekRateLimit, windowClock } from './ratelimit.js'

export const KEY_COUNTER = (id: string) => `xsearch:key:${id}`
export const PUBLIC_COUNTER = 'xsearch:public'

export interface PoolSettings {
  /** Minutes without any request before a key's reservation is released to the public. */
  idleReleaseMinutes: number
}

const SETTINGS_KEY = 'pool:settings'
const SNAPSHOT_TTL_MS = 5_000
const MIN_IDLE_MINUTES = 15
const MAX_IDLE_MINUTES = 24 * 60
/** Multiplier on the observed pace when projecting a key's remaining demand. */
const PACE_SAFETY = 2

function defaultIdleMinutes(): number {
  const env = Number(process.env.X_MD_KEY_IDLE_RELEASE_MINUTES)
  return Number.isFinite(env) && env > 0 ? clampIdle(env) : 60
}

export function clampIdle(minutes: number): number {
  return Math.min(MAX_IDLE_MINUTES, Math.max(MIN_IDLE_MINUTES, Math.floor(minutes)))
}

let settingsCache: { value: PoolSettings; at: number } | undefined

export async function getPoolSettings(): Promise<PoolSettings> {
  if (settingsCache && Date.now() - settingsCache.at < SNAPSHOT_TTL_MS) return settingsCache.value
  let value: PoolSettings = { idleReleaseMinutes: defaultIdleMinutes() }
  try {
    const raw = await kv().get(SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PoolSettings>
      if (typeof parsed.idleReleaseMinutes === 'number') value = { idleReleaseMinutes: clampIdle(parsed.idleReleaseMinutes) }
    }
  } catch {
    // fall back to defaults
  }
  settingsCache = { value, at: Date.now() }
  return value
}

export async function setPoolSettings(patch: Partial<PoolSettings>): Promise<PoolSettings> {
  const current = await getPoolSettings()
  const next: PoolSettings = { ...current }
  if (typeof patch.idleReleaseMinutes === 'number' && Number.isFinite(patch.idleReleaseMinutes)) {
    next.idleReleaseMinutes = clampIdle(patch.idleReleaseMinutes)
  }
  await kv().set(SETTINGS_KEY, JSON.stringify(next))
  resetPool()
  return next
}

export interface ReservationInput {
  limit: number
  disabled: boolean
  /** Requests charged to the key in the current window. */
  used: number
  /** Requests charged in the previous window (pace hint). */
  previousUsed: number
  lastUsedAt?: number
}

/**
 * How much of a key's allowance to hold back from the public for the rest of
 * the current window. Pure so it can be unit tested against a fixed clock.
 */
export function reservationFor(
  input: ReservationInput,
  clock: { elapsedSec: number; remainingSec: number },
  windowSec: number,
  idleReleaseMs: number,
  now = Date.now(),
): { reserved: number; idle: boolean } {
  const remaining = Math.max(0, input.limit - input.used)
  if (input.disabled) return { reserved: 0, idle: false }
  const idle = !input.lastUsedAt || now - input.lastUsedAt >= idleReleaseMs
  if (idle || remaining === 0 || clock.remainingSec <= 0) return { reserved: 0, idle }

  const pace = Math.max(input.used / Math.max(1, clock.elapsedSec), input.previousUsed / windowSec)
  const byPace = pace * clock.remainingSec * PACE_SAFETY
  const byTime = (remaining * clock.remainingSec) / windowSec
  const reserved = Math.min(remaining, Math.ceil(Math.max(byPace, byTime)))
  return { reserved, idle: false }
}

export interface KeyShare {
  id: string
  label: string
  limit: number
  disabled: boolean
  used: number
  reserved: number
  idle: boolean
  lastUsedAt?: number
}

export interface PoolSnapshot {
  capacity: number
  windowSec: number
  windowElapsedSec: number
  windowRemainingSec: number
  idleReleaseMinutes: number
  keysUsed: number
  keysReserved: number
  publicCap: number
  publicUsed: number
  publicRemaining: number
  keys: KeyShare[]
}

let snapshotCache: { value: PoolSnapshot; at: number; capacity: number; bucket: number } | undefined

/** Test/admin hook: drop cached settings and snapshot. */
export function resetPool(): void {
  settingsCache = undefined
  snapshotCache = undefined
}

/**
 * Current split of the pool. Cached briefly per process: it costs a key listing
 * plus one counter read, and a few seconds of staleness is harmless here.
 */
export async function poolSnapshot(capacity: number, windowSec: number): Promise<PoolSnapshot> {
  const now = Date.now()
  const { bucket } = windowClock(windowSec, now)
  // Never serve a snapshot across a window boundary: the counters it was built from have rolled over.
  if (snapshotCache && snapshotCache.capacity === capacity && snapshotCache.bucket === bucket && now - snapshotCache.at < SNAPSHOT_TTL_MS) {
    return snapshotCache.value
  }
  const value = await computeSnapshot(capacity, windowSec, now)
  snapshotCache = { value, at: now, capacity, bucket }
  return value
}

async function computeSnapshot(capacity: number, windowSec: number, now: number): Promise<PoolSnapshot> {
  const [settings, records] = await Promise.all([getPoolSettings(), listApiKeys()])
  const clock = windowClock(windowSec, now)
  const counts = await peekRateLimit([PUBLIC_COUNTER, ...records.map((r) => KEY_COUNTER(r.id))], windowSec)
  const publicUsed = counts.current[0] ?? 0
  const idleReleaseMs = settings.idleReleaseMinutes * 60_000

  const keys = records.map((record: ApiKeyRecord, index): KeyShare => {
    const used = counts.current[index + 1] ?? 0
    const previousUsed = counts.previous[index + 1] ?? 0
    const { reserved, idle } = reservationFor(
      { limit: record.limitPer15m, disabled: record.disabled, used, previousUsed, lastUsedAt: record.lastUsedAt },
      clock, windowSec, idleReleaseMs, now,
    )
    return { id: record.id, label: record.label, limit: record.limitPer15m, disabled: record.disabled, used, reserved, idle, lastUsedAt: record.lastUsedAt }
  })

  const keysUsed = keys.reduce((sum, k) => sum + k.used, 0)
  const keysReserved = keys.reduce((sum, k) => sum + k.reserved, 0)
  const publicCap = Math.max(0, capacity - keysUsed - keysReserved)
  return {
    capacity,
    windowSec,
    windowElapsedSec: clock.elapsedSec,
    windowRemainingSec: clock.remainingSec,
    idleReleaseMinutes: settings.idleReleaseMinutes,
    keysUsed,
    keysReserved,
    publicCap,
    publicUsed,
    publicRemaining: Math.max(0, publicCap - publicUsed),
    keys,
  }
}
