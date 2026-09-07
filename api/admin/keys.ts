import type { VercelRequest, VercelResponse } from '@vercel/node'
import { adminAuthorized, adminConfigured } from '../../lib/admin.js'
import { handleKeysApi } from '../../lib/adminApi.js'
import { parseJsonBody, setCorsHeaders } from '../../lib/http.js'

const METHODS = 'GET, POST, PATCH, DELETE, OPTIONS'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, METHODS)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin is not configured (set X_MD_ADMIN_TOKEN).' })
  if (!adminAuthorized(req.headers)) return res.status(401).json({ error: 'Unauthorized' })

  const parsed = parseJsonBody(req.body)
  if (!parsed.ok) return res.status(400).json({ error: 'Invalid JSON body' })
  const { status, body: payload } = await handleKeysApi(req.method ?? 'GET', parsed.value)
  if (status === 405) res.setHeader('Allow', METHODS)
  return res.status(status).json(payload)
}
