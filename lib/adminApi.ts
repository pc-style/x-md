/**
 * Transport-agnostic admin operations, shared by the Vercel functions and the
 * Vite dev middleware so behavior is identical in both. Callers are responsible
 * for admin authentication before invoking these.
 */
import { createApiKey, deleteApiKey, listApiKeys, toView, updateApiKey, type ApiKeyRecord } from './apikeys.js'
import { kvDurable } from './kv.js'
import { resetPool, setPoolSettings } from './pool.js'
import { defaultKeyLimitPer15m, searchPoolSnapshot, searchRateModel } from './xsearch.js'

export interface AdminResponse {
  status: number
  body: unknown
}

function positiveLimit(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

export async function handleKeysApi(method: string, body: unknown): Promise<AdminResponse> {
  const input = (body ?? {}) as Record<string, unknown>
  switch (method) {
    case 'GET': {
      const keys = (await listApiKeys()).map(toView)
      return { status: 200, body: { keys, defaultLimit: defaultKeyLimitPer15m() } }
    }
    case 'POST': {
      const label = (typeof input.label === 'string' ? input.label : '').trim().slice(0, 80) || 'unnamed'
      let limit = defaultKeyLimitPer15m()
      if (input.limitPer15m !== undefined && input.limitPer15m !== null && input.limitPer15m !== '') {
        const given = positiveLimit(input.limitPer15m)
        if (given === undefined) return { status: 400, body: { error: 'limitPer15m must be a positive integer' } }
        limit = given
      }
      const { record, secret } = await createApiKey(label, limit)
      return { status: 201, body: { key: toView(record), secret } }
    }
    case 'PATCH': {
      const id = typeof input.id === 'string' ? input.id : ''
      if (!id) return { status: 400, body: { error: 'id is required' } }
      const patch: Partial<Pick<ApiKeyRecord, 'label' | 'limitPer15m' | 'disabled'>> = {}
      if (typeof input.label === 'string') patch.label = input.label.trim().slice(0, 80)
      if (input.limitPer15m !== undefined) {
        const limit = positiveLimit(input.limitPer15m)
        if (limit === undefined) return { status: 400, body: { error: 'limitPer15m must be a positive integer' } }
        patch.limitPer15m = limit
      }
      if (typeof input.disabled === 'boolean') patch.disabled = input.disabled
      const updated = await updateApiKey(id, patch)
      resetPool()
      return updated ? { status: 200, body: { key: toView(updated) } } : { status: 404, body: { error: 'not found' } }
    }
    case 'DELETE': {
      const id = typeof input.id === 'string' ? input.id : ''
      if (!id) return { status: 400, body: { error: 'id is required' } }
      const ok = await deleteApiKey(id)
      resetPool()
      return ok ? { status: 200, body: { deleted: id } } : { status: 404, body: { error: 'not found' } }
    }
    default:
      return { status: 405, body: { error: 'method not allowed' } }
  }
}

export async function handlePoolApi(method = 'GET', body: unknown = {}): Promise<AdminResponse> {
  if (method === 'PATCH') {
    const input = (body ?? {}) as Record<string, unknown>
    const minutes = positiveLimit(input.idleReleaseMinutes)
    if (minutes === undefined) return { status: 400, body: { error: 'idleReleaseMinutes must be a positive number' } }
    await setPoolSettings({ idleReleaseMinutes: minutes })
  } else if (method !== 'GET') {
    return { status: 405, body: { error: 'method not allowed' } }
  }
  resetPool() // admin wants a live view, not the few-second cache
  const model = searchRateModel()
  const [keys, share] = await Promise.all([listApiKeys(), searchPoolSnapshot()])
  const active = keys.filter((k) => !k.disabled)
  return {
    status: 200,
    body: {
      ...model,
      durableStore: kvDurable(),
      keyCount: keys.length,
      activeKeyCount: active.length,
      allocatedToKeysPer15m: active.reduce((sum, k) => sum + k.limitPer15m, 0),
      share,
    },
  }
}
