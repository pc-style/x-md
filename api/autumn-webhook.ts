import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024

export const config = {
  api: {
    bodyParser: false,
  },
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  let rawBody: Buffer
  try {
    rawBody = await readRawBody(req)
  } catch (error) {
    return res.status(413).json({
      error: error instanceof Error ? error.message : 'Webhook body is too large',
      code: 'body_too_large',
    })
  }
  const signature = String(req.headers['autumn-signature'] ?? req.headers['x-autumn-signature'] ?? '')

  if (!verifyAutumnWebhook(rawBody, signature, process.env.AUTUMN_WEBHOOK_SECRET)) {
    return res.status(400).json({ error: 'Invalid webhook signature', code: 'invalid_signature' })
  }

  // Autumn remains the billing source of truth. Keep this endpoint small: verify
  // the raw body, then enqueue/mirror only the data needed for account debugging.
  return res.status(200).json({ ok: true })
}

export function verifyAutumnWebhook(rawBody: Buffer, signature: string, secret: string | undefined): boolean {
  if (!secret || !signature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  const candidates = signature.split(',').map((part) => part.trim().replace(/^v\d+=/, ''))
  return candidates.some((candidate) => safeEqualHex(candidate, expected))
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'hex')
    const right = Buffer.from(b, 'hex')
    return left.length === right.length && timingSafeEqual(left, right)
  } catch {
    return false
  }
}

async function readRawBody(req: VercelRequest, maxBytes = MAX_WEBHOOK_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) {
      req.destroy()
      throw new Error(`Webhook body exceeds ${maxBytes} bytes`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
