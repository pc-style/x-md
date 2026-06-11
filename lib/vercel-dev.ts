import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VercelRequest, VercelResponse } from '@vercel/node'

export function createVercelRequest(
  req: IncomingMessage,
  url: URL,
  body: unknown = undefined,
): VercelRequest {
  const query = Object.fromEntries(url.searchParams.entries())
  return Object.assign(req, { query, body, cookies: {} }) as VercelRequest
}

export function createVercelResponse(res: ServerResponse): VercelResponse {
  const vercelRes = {
    status(code: number) {
      res.statusCode = code
      return vercelRes
    },
    setHeader(name: string, value: string | string[]) {
      res.setHeader(name, value)
      return vercelRes
    },
    getHeader(name: string) {
      return res.getHeader(name)
    },
    json(payload: unknown) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
      }
      res.end(JSON.stringify(payload))
      return vercelRes
    },
    send(payload: unknown) {
      if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
        res.end(payload)
        return vercelRes
      }
      return vercelRes.json(payload)
    },
    end(payload?: string) {
      res.end(payload)
      return vercelRes
    },
  }
  return vercelRes as VercelResponse
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`)
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return undefined
  return JSON.parse(text) as unknown
}
