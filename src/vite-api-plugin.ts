import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { ConvertError, convertTweet, markdownResponse } from '../lib/converter'

async function handleConvert(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const pathname = url.pathname

  const statusMatch = pathname.match(/^\/([^/]+)\/status\/(\d+)\/?$/)
  const isApi = pathname === '/api/convert'

  if (!isApi && !statusMatch) return false

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return true
  }

  const accept = String(req.headers.accept ?? '')
  const asJson = accept.includes('application/json')

  try {
    const result = await convertTweet({
      url: url.searchParams.get('url'),
      handle: statusMatch?.[1] ?? url.searchParams.get('handle'),
      id: statusMatch?.[2] ?? url.searchParams.get('id'),
      format: url.searchParams.get('format'),
      thread: url.searchParams.get('thread'),
      userinfo: url.searchParams.get('userinfo'),
      nocache: url.searchParams.get('nocache'),
    })

    const { status, headers, body } = markdownResponse(result, asJson)
    res.statusCode = status
    for (const [key, value] of Object.entries(headers)) {
      res.setHeader(key, value)
    }
    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(body)
    }
  } catch (error) {
    if (error instanceof ConvertError) {
      res.statusCode = error.status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: error.message, code: error.code }))
    } else {
      console.error(error)
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Internal converter error' }))
    }
  }

  return true
}

export function apiDevPlugin(): Plugin {
  return {
    name: 'x-md-api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url) return next()
        const url = new URL(req.url, 'http://localhost')
        const handled = await handleConvert(url, req, res)
        if (!handled) next()
      })
    },
  }
}
