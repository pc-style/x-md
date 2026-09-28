import type { IncomingMessage, ServerResponse } from 'node:http'

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify({ ok: true, configured: Boolean(process.env.X_MD_API_KEY) }))
}
