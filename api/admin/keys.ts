import type { VercelRequest, VercelResponse } from '@vercel/node'
import { adminAuthorized, adminConfigured } from '../../lib/admin.js'
import { handleKeysApi } from '../../lib/adminApi.js'
import { problemDetails, requestInstance, sendProblem } from '../../lib/apierror.js'
import { parseJsonBody, requestOrigin, setCorsHeaders } from '../../lib/http.js'

const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, METHODS)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, requestOrigin(req))
  const fail = (code: string, detail?: string) =>
    sendProblem(res, problemDetails(code, { instance, detail }), accept, req.method)

  if (!adminConfigured()) return fail('admin_unconfigured')
  if (!adminAuthorized(req.headers)) return fail('unauthorized', 'Admin routes require a valid X-Md-Admin-Token.')

  const parsed = parseJsonBody(req.body)
  if (!parsed.ok) return fail('invalid_body')
  const { status, body: payload, failure } = await handleKeysApi(req.method ?? 'GET', parsed.value)
  if (failure) {
    if (status === 405) res.setHeader('Allow', METHODS)
    return fail(failure.code, failure.detail)
  }
  return res.status(status).json(payload)
}
