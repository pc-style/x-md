/**
 * API key store. Keys grant a higher, per-key search allowance drawn from the
 * account pool (see `xsearch.ts`). Secrets are shown once at creation and only
 * their SHA-256 hash is persisted, so a store leak cannot reveal usable keys.
 *
 * Intentionally undocumented in the public skill/API surface: keys are handed
 * out privately and managed from the admin dashboard.
 */
import { createHash, randomBytes } from 'node:crypto'
import { kv } from './kv.js'

export interface ApiKeyRecord {
  id: string
  label: string
  limitPer15m: number
  disabled: boolean
  createdAt: number
  /** Stored under its own key so activity stamps never race admin edits of the record. */
  lastUsedAt?: number
  /** SHA-256 of the secret; server-side only, stripped from admin responses. */
  hash: string
}

/** Admin-facing view of a key with the secret hash removed. */
export type ApiKeyView = Omit<ApiKeyRecord, 'hash'>

const INDEX = 'apikeys:ids'
const recordKey = (id: string) => `apikey:rec:${id}`
const hashKey = (hash: string) => `apikey:hash:${hash}`
const lastUsedKey = (id: string) => `apikey:last:${id}`

function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function toView(record: ApiKeyRecord): ApiKeyView {
  const { hash: _hash, ...view } = record
  return view
}

function parseRecord(raw: string | null, lastUsed: string | null): ApiKeyRecord | null {
  if (!raw) return null
  const record = JSON.parse(raw) as ApiKeyRecord
  const stamp = lastUsed ? Number(lastUsed) : NaN
  return Number.isFinite(stamp) ? { ...record, lastUsedAt: stamp } : record
}

function stripStamp(record: ApiKeyRecord): ApiKeyRecord {
  const { lastUsedAt: _stamp, ...rest } = record
  return rest as ApiKeyRecord
}

export async function createApiKey(label: string, limitPer15m: number): Promise<{ record: ApiKeyRecord; secret: string }> {
  const id = randomBytes(6).toString('hex')
  const secret = `xmd_${randomBytes(24).toString('hex')}`
  const hash = hashSecret(secret)
  const record: ApiKeyRecord = { id, label, limitPer15m, disabled: false, createdAt: Date.now(), hash }
  // Record and index first, hash mapping last: a partial failure leaves a visible,
  // unusable key that the dashboard can delete, never an invisible usable one.
  await kv().set(recordKey(id), JSON.stringify(record))
  await kv().sadd(INDEX, id)
  await kv().set(hashKey(hash), id)
  return { record, secret }
}

export async function getApiKey(id: string): Promise<ApiKeyRecord | null> {
  const [raw, last] = await kv().mget([recordKey(id), lastUsedKey(id)])
  return parseRecord(raw ?? null, last ?? null)
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const ids = await kv().smembers(INDEX)
  if (ids.length === 0) return []
  const values = await kv().mget([...ids.map(recordKey), ...ids.map(lastUsedKey)])
  return ids
    .map((_, i) => parseRecord(values[i] ?? null, values[ids.length + i] ?? null))
    .filter((record): record is ApiKeyRecord => record !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKeyRecord, 'label' | 'limitPer15m' | 'disabled'>>,
): Promise<ApiKeyRecord | null> {
  const current = await getApiKey(id)
  if (!current) return null
  const next: ApiKeyRecord = { ...current, ...patch }
  await kv().set(recordKey(id), JSON.stringify(stripStamp(next)))
  return next
}

export async function deleteApiKey(id: string): Promise<boolean> {
  const current = await getApiKey(id)
  if (!current) return false
  await kv().del(hashKey(current.hash))
  await kv().del(recordKey(id))
  await kv().del(lastUsedKey(id))
  await kv().srem(INDEX, id)
  return true
}

/**
 * Resolve a presented secret. Returns the record for a valid, enabled key;
 * `'invalid'` when a key was presented but is unknown or disabled; `null` when
 * no key was presented (anonymous request).
 */
export async function resolveApiKey(raw: string | undefined | null): Promise<ApiKeyRecord | 'invalid' | null> {
  if (!raw) return null
  const id = await kv().get(hashKey(hashSecret(raw)))
  if (!id) return 'invalid'
  const record = await getApiKey(id)
  if (!record || record.disabled) return 'invalid'
  return record
}

/** Re-stamp at most this often; idle detection works in minutes, so seconds of slack are fine. */
const TOUCH_INTERVAL_MS = 30_000

/**
 * Best-effort last-used stamp. Writes only the stamp key, so it can never
 * overwrite a concurrent admin edit (disable, limit change) of the record.
 */
export async function touchApiKey(record: ApiKeyRecord, now = Date.now()): Promise<void> {
  if (record.lastUsedAt && now - record.lastUsedAt < TOUCH_INTERVAL_MS) return
  try {
    await kv().set(lastUsedKey(record.id), String(now))
  } catch {
    // non-critical
  }
}
