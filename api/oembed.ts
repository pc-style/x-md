import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { oembedResponse } from '../lib/embed.js'
import { requestOrigin, setCorsHeaders } from '../lib/http.js'

export default function handler(req: VercelRequest, res: VercelResponse) {
  trackRequest(req, res, 'oembed')
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const param = (key: string): string | undefined => (typeof req.query[key] === 'string' ? req.query[key] : undefined)
  const { status, headers, body } = oembedResponse(
    {
      url: param('url'),
      text: param('text'),
      author: param('author'),
      status: param('status'),
      provider: param('provider'),
    },
    requestOrigin(req),
  )
  for (const [key, value] of Object.entries(headers)) {
    res.setHeader(key, value)
  }
  return req.method === 'HEAD' ? res.status(status).end() : res.status(status).send(body)
}
