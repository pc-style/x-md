import type { Connect } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  acceptPrefersHtml,
  ConvertError,
  convertTweet,
  markdownResponse,
} from '../lib/converter'
import { createVercelRequest, createVercelResponse, readJsonBody } from '../lib/vercel-dev'

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
  const asHtml = acceptPrefersHtml(accept)

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

    const { status, headers, body } = markdownResponse(result, asJson, asHtml)
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

type ApiHandler = (req: VercelRequest, res: VercelResponse) => Promise<unknown>

const API_HANDLERS: Record<string, () => Promise<{ default: ApiHandler }>> = {
  '/api/billing': () => import('../api/billing'),
  '/api/account': () => import('../api/account'),
  '/api/api-keys': () => import('../api/api-keys'),
}

async function handleVercelApiRoute(
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const load = API_HANDLERS[pathname]
  if (!load) return false

  let body: unknown
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
    try {
      body = await readJsonBody(req)
    } catch (error) {
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'Invalid request body',
        code: 'invalid_body',
      }))
      return true
    }
  }

  const handler = (await load()).default
  await handler(createVercelRequest(req, url, body), createVercelResponse(res))
  return true
}

function installConvertMiddleware(middlewares: Connect.Server) {
  middlewares.use((req, res, next) => {
    void (async () => {
      try {
        if (!req.url) {
          next()
          return
        }
        if (req.url === '/dashboard' || req.url.startsWith('/dashboard?')) {
          req.url = '/dashboard.html'
          next()
          return
        }
        const url = new URL(req.url, 'http://localhost')
        if (await handleVercelApiRoute(url.pathname, req, res, url)) return
        const handled = await handleConvert(url, req, res)
        if (!handled) next()
      } catch (error) {
        next(error as Error)
      }
    })()
  })
}

export function apiDevPlugin(): Plugin {
  return {
    name: 'x-md-api-dev',
    enforce: 'pre',
    configureServer(server) {
      installConvertMiddleware(server.middlewares)
    },
    configurePreviewServer(server) {
      installConvertMiddleware(server.middlewares)
    },
  }
}
