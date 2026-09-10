import type { VercelRequest, VercelResponse } from '@vercel/node'
import { adminAuthorized, adminConfigured } from '../../lib/admin.js'
import { problemDetails, requestInstance, sendProblem } from '../../lib/apierror.js'
import { requestOrigin, setCorsHeaders } from '../../lib/http.js'
import { upstreamHealth } from '../../lib/upstream-health.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  const accept = String(req.headers.accept ?? '')
  const instance = requestInstance(req, requestOrigin(req))
  const fail = (code: string, detail?: string) => sendProblem(res, problemDetails(code, { instance, detail }), accept, req.method)
  if (!adminConfigured()) return fail('admin_unconfigured')
  if (!adminAuthorized(req.headers)) return fail('unauthorized', 'Admin routes require a valid X-Md-Admin-Token.')
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET, OPTIONS'); return fail('method_not_allowed') }
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json({ upstreams: await upstreamHealth(), generatedAt: new Date().toISOString() })
}
