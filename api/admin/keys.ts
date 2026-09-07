import type { VercelRequest, VercelResponse } from '@vercel/node'
import { adminAuthorized, adminConfigured } from '../../lib/admin.js'
import { handleKeysApi } from '../../lib/adminApi.js'
import { setCorsHeaders } from '../../lib/http.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res, 'GET, POST, PATCH, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (!adminConfigured()) return res.status(503).json({ error: 'Admin is not configured (set X_MD_ADMIN_TOKEN).' })
  if (!adminAuthorized(req.headers)) return res.status(401).json({ error: 'Unauthorized' })

  const body = typeof req.body === 'string' ? safeParse(req.body) : req.body
  const { status, body: payload } = await handleKeysApi(req.method ?? 'GET', body)
  return res.status(status).json(payload)
}

function safeParse(raw: string): unknown {
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
