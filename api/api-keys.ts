import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api.js'
import { logRequest, resolveAuthContext, syncUserToBackends } from '../lib/auth.js'
import { createApiKey, hashApiKey } from '../lib/monetization.js'

function convexClient(): ConvexHttpClient | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL
  return url ? new ConvexHttpClient(url) : null
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  const auth = await resolveAuthContext(req.headers)
  if (!auth.userId) {
    return res.status(401).json({ error: 'Sign in to manage API keys.', code: 'authentication_required' })
  }

  const convex = convexClient()
  if (!convex) {
    return res.status(500).json({ error: 'Convex is not configured.', code: 'convex_not_configured' })
  }

  await syncUserToBackends(auth)

  if (req.method === 'GET') {
    const keys = await convex.query(api.apiKeys.listForUser, { userId: auth.userId })
    await logRequest({ auth, route: '/api/api-keys', status: 200 })
    return res.status(200).json({ keys })
  }

  if (req.method === 'POST') {
    const generated = createApiKey()
    await convex.mutation(api.apiKeys.create, {
      userId: auth.userId,
      keyHash: generated.keyHash,
      tokenPreview: generated.tokenPreview,
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
    })
    return res.status(201).json({ apiKey: generated.apiKey, tokenPreview: generated.tokenPreview })
  }

  if (req.method === 'DELETE') {
    const keyHash = typeof req.query.keyHash === 'string'
      ? req.query.keyHash
      : typeof req.body?.keyHash === 'string'
        ? req.body.keyHash
        : typeof req.body?.apiKey === 'string'
          ? hashApiKey(req.body.apiKey)
          : null

    if (!keyHash) {
      return res.status(400).json({ error: 'Provide `keyHash` or `apiKey` to revoke.', code: 'missing_key' })
    }

    const revoked = await convex.mutation(api.apiKeys.revoke, { userId: auth.userId, keyHash })
    return res.status(200).json({ revoked })
  }

  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'Method not allowed' })
}

function setCorsHeaders(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type')
}
