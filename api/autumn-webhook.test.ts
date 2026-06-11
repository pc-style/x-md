import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { verifyAutumnWebhook } from './autumn-webhook.js'

describe('Autumn webhook verification', () => {
  test('validates signatures against the exact raw request body', () => {
    const raw = Buffer.from('{"event" : "billing.updated", "spacing" : true}')
    const signature = createHmac('sha256', 'whsec_test').update(raw).digest('hex')

    expect(verifyAutumnWebhook(raw, signature, 'whsec_test')).toBe(true)
    expect(verifyAutumnWebhook(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), signature, 'whsec_test')).toBe(false)
  })
})
