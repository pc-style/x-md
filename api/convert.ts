import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ConvertError, acceptPrefersHtml, convertTweet, markdownResponse } from '../lib/converter.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const accept = String(req.headers.accept ?? '')
  const asJson = accept.includes('application/json')
  const asHtml = acceptPrefersHtml(accept)

  try {
    const result = await convertTweet({
      url: typeof req.query.url === 'string' ? req.query.url : undefined,
      handle: typeof req.query.handle === 'string' ? req.query.handle : undefined,
      id: typeof req.query.id === 'string' ? req.query.id : undefined,
      format: typeof req.query.format === 'string' ? req.query.format : undefined,
      thread: typeof req.query.thread === 'string' ? req.query.thread : undefined,
      userinfo: typeof req.query.userinfo === 'string' ? req.query.userinfo : undefined,
      nocache: typeof req.query.nocache === 'string' ? req.query.nocache : undefined,
    })

    const { status, headers, body } = markdownResponse(result, asJson, asHtml)
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }

    if (req.method === 'HEAD') {
      return res.status(status).end()
    }

    return res.status(status).send(body)
  } catch (error) {
    if (error instanceof ConvertError) {
      return res.status(error.status).json({
        error: error.message,
        code: error.code,
      })
    }

    console.error(error)
    return res.status(500).json({ error: 'Internal converter error' })
  }
}
