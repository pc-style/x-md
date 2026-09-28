import type { IncomingMessage, ServerResponse } from 'node:http'
import { CircleError, collectCircle, type CircleEvent } from './engine'
import { beginCircle } from './http'

export const config = { maxDuration: 60 }

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded
  return value?.split(',')[0]?.trim() || 'unknown'
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.statusCode = 405
    res.end('Method not allowed')
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  const gate = beginCircle(clientIp(req))
  if (!gate.ok) {
    res.statusCode = 429
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Retry-After', String(gate.retryAfter))
    res.end(JSON.stringify({ code: 'rate_limited' }))
    return
  }
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 55_000)
  if (typeof req.on === 'function') req.on('close', () => abort.abort())
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  const send = (event: CircleEvent) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  try {
    await collectCircle(url.searchParams.get('handle') ?? '', {
      fresh: url.searchParams.get('fresh') === '1',
      signal: abort.signal,
      onEvent: send,
    })
  } catch (error) {
    const code = error instanceof CircleError ? error.code : 'unavailable'
    if (code !== 'aborted') send({ type: 'error', code })
  } finally {
    clearTimeout(timer)
    gate.finish()
    if (!res.writableEnded) res.end()
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await handle(req, res)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'failed'
    if (!res.writableEnded) {
      res.statusCode = 500
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ code: 'unavailable', detail }))
    }
  }
}
