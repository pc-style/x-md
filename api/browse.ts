import type { VercelRequest, VercelResponse } from '@vercel/node'
import { browse, browseResponse } from '../lib/browse.js'
import { ConvertError } from '../lib/errors.js'
import { setCorsHeaders, wantsJson } from '../lib/http.js'
import { clientIp } from '../lib/ratelimit.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS')
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const param = (key: string): string | undefined => typeof req.query[key] === 'string' ? req.query[key] : undefined
  try {
    const result = await browse({ resource: param('resource'), handle: param('handle'), q: param('q'), feed: param('feed'), cursor: param('cursor'), page: param('page'), limit: param('limit'), full: param('full'), format: param('format'), nocache: param('nocache'), ip: clientIp(req.headers) })
    const response = browseResponse(result, wantsJson(param('format'), String(req.headers.accept ?? '')))
    for (const [key, header] of Object.entries(response.headers)) res.setHeader(key, header)
    return req.method === 'HEAD' ? res.status(response.status).end() : res.status(response.status).send(response.body)
  } catch (error) {
    if (error instanceof ConvertError) {
      if (error.status === 503) res.setHeader('Retry-After', '30')
      if (error.status === 429) {
        res.setHeader('Retry-After', String(error.retryAfter ?? 60))
        res.setHeader('Cache-Control', 'no-store')
      }
      return res.status(error.status).json({ error: error.message, code: error.code })
    }
    console.error(error)
    return res.status(500).json({ error: 'Internal browse error' })
  }
}
