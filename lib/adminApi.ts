/**
 * Transport-agnostic admin operations, shared by the Vercel functions and the
 * Vite dev middleware so behavior is identical in both. Callers are responsible
 * for admin authentication before invoking these.
 */
import { IMPORT_KEY } from './quotas.js'
import { createApiKey, deleteApiKey, listApiKeys, toView, updateApiKey, type ApiKeyRecord } from './apikeys.js'
import { kvDurable } from './kv.js'
import { resetPool, setPoolSettings } from './pool.js'
import { defaultKeyLimitPer15m, searchPoolSnapshot, searchRateModel } from './xsearch.js'

/** A failed operation, for the transport to send as problem details. `code` names an ERROR_CATALOG entry. */
export interface AdminFailure {
  code: string
  detail: string
}

export interface AdminResponse {
  status: number
  body?: unknown
  /** Set instead of `body` when the operation failed. */
  failure?: AdminFailure
}

const failed = (status: number, code: string, detail: string): AdminResponse => ({ status, failure: { code, detail } })

function positiveLimit(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined
}

export async function handleKeysApi(method: string, body: unknown): Promise<AdminResponse> {
  const input = (body ?? {}) as Record<string, unknown>
  switch (method) {
    case 'GET': {
      const keys = (await listApiKeys()).map(toView)
      return { status: 200, body: { keys, defaultLimit: defaultKeyLimitPer15m(), defaultImportLimit: IMPORT_KEY.quota } }
    }
    case 'POST': {
      const label = (typeof input.label === 'string' ? input.label : '').trim().slice(0, 80) || 'unnamed'
      let limit = defaultKeyLimitPer15m()
      if (input.limitPer15m !== undefined && input.limitPer15m !== null && input.limitPer15m !== '') {
        const given = positiveLimit(input.limitPer15m)
        if (given === undefined) return failed(400, 'invalid_body', 'limitPer15m must be a positive integer.')
        limit = given
      }
      let importLimit: number | undefined
      if (input.importPer15m !== undefined && input.importPer15m !== null && input.importPer15m !== '') {
        importLimit = positiveLimit(input.importPer15m)
        if (importLimit === undefined) return failed(400, 'invalid_body', 'importPer15m must be a positive integer.')
      }
      const { record, secret } = await createApiKey(label, limit, importLimit)
      return { status: 201, body: { key: toView(record), secret } }
    }
    case 'PATCH': {
      const id = typeof input.id === 'string' ? input.id : ''
      if (!id) return failed(400, 'invalid_body', 'id is required.')
      const patch: Partial<Pick<ApiKeyRecord, 'label' | 'limitPer15m' | 'importPer15m' | 'disabled'>> = {}
      if (typeof input.label === 'string') patch.label = input.label.trim().slice(0, 80)
      if (input.limitPer15m !== undefined) {
        const limit = positiveLimit(input.limitPer15m)
        if (limit === undefined) return failed(400, 'invalid_body', 'limitPer15m must be a positive integer.')
        patch.limitPer15m = limit
      }
      if (input.importPer15m !== undefined) {
        const limit = positiveLimit(input.importPer15m)
        if (limit === undefined) return failed(400, 'invalid_body', 'importPer15m must be a positive integer.')
        patch.importPer15m = limit
      }
      if (typeof input.disabled === 'boolean') patch.disabled = input.disabled
      const updated = await updateApiKey(id, patch)
      resetPool()
      return updated ? { status: 200, body: { key: toView(updated) } } : failed(404, 'not_found', 'No API key with that id.')
    }
    case 'DELETE': {
      const id = typeof input.id === 'string' ? input.id : ''
      if (!id) return failed(400, 'invalid_body', 'id is required.')
      const ok = await deleteApiKey(id)
      resetPool()
      return ok ? { status: 200, body: { deleted: id } } : failed(404, 'not_found', 'No API key with that id.')
    }
    default:
      return failed(405, 'method_not_allowed', `${method} is not supported on this route.`)
  }
}

export async function handlePoolApi(method = 'GET', body: unknown = {}): Promise<AdminResponse> {
  if (method === 'PATCH') {
    const input = (body ?? {}) as Record<string, unknown>
    const minutes = positiveLimit(input.idleReleaseMinutes)
    if (minutes === undefined) return failed(400, 'invalid_body', 'idleReleaseMinutes must be a positive number.')
    await setPoolSettings({ idleReleaseMinutes: minutes })
  } else if (method !== 'GET') {
    return failed(405, 'method_not_allowed', `${method} is not supported on this route.`)
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
