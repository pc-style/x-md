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
  lastUsedAt?: number
  /** SHA-256 of the secret; server-side only, stripped from admin responses. */
  hash: string
}

/** Admin-facing view of a key with the secret hash removed. */
export type ApiKeyView = Omit<ApiKeyRecord, 'hash'>

const INDEX = 'apikeys:ids'
const recordKey = (id: string) => `apikey:rec:${id}`
const hashKey = (hash: string) => `apikey:hash:${hash}`

function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export function toView(record: ApiKeyRecord): ApiKeyView {
  const { hash: _hash, ...view } = record
  return view
}

export async function createApiKey(label: string, limitPer15m: number): Promise<{ record: ApiKeyRecord; secret: string }> {
  const id = randomBytes(6).toString('hex')
  const secret = `xmd_${randomBytes(24).toString('hex')}`
  const hash = hashSecret(secret)
  const record: ApiKeyRecord = { id, label, limitPer15m, disabled: false, createdAt: Date.now(), hash }
  await kv().set(recordKey(id), JSON.stringify(record))
  await kv().set(hashKey(hash), id)
  await kv().sadd(INDEX, id)
  return { record, secret }
}

export async function getApiKey(id: string): Promise<ApiKeyRecord | null> {
  const raw = await kv().get(recordKey(id))
  return raw ? (JSON.parse(raw) as ApiKeyRecord) : null
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const ids = await kv().smembers(INDEX)
  const raws = await Promise.all(ids.map((id) => kv().get(recordKey(id))))
  return raws
    .filter((raw): raw is string => raw !== null)
    .map((raw) => JSON.parse(raw) as ApiKeyRecord)
    .sort((a, b) => b.createdAt - a.createdAt)
}

export async function updateApiKey(
  id: string,
  patch: Partial<Pick<ApiKeyRecord, 'label' | 'limitPer15m' | 'disabled'>>,
): Promise<ApiKeyRecord | null> {
  const current = await getApiKey(id)
  if (!current) return null
  const next: ApiKeyRecord = { ...current, ...patch }
  await kv().set(recordKey(id), JSON.stringify(next))
  return next
}

export async function deleteApiKey(id: string): Promise<boolean> {
  const current = await getApiKey(id)
  if (!current) return false
  await kv().del(hashKey(current.hash))
  await kv().del(recordKey(id))
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

/** Best-effort last-used stamp; failures are ignored so they never block a request. */
export async function touchApiKey(record: ApiKeyRecord, now = Date.now()): Promise<void> {
  if (record.lastUsedAt && now - record.lastUsedAt < TOUCH_INTERVAL_MS) return
  try {
    await kv().set(recordKey(record.id), JSON.stringify({ ...record, lastUsedAt: now }))
  } catch {
    // non-critical
  }
}
