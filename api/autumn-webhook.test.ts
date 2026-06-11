import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { verifyAutumnWebhook } from './autumn-webhook.js'

describe('Autumn webhook verification', () => {
  test('validates legacy hex signatures against the exact raw request body', () => {
    const raw = Buffer.from('{"event" : "billing.updated", "spacing" : true}')
    const signature = createHmac('sha256', 'whsec_test').update(raw).digest('hex')

    expect(verifyAutumnWebhook(raw, signature, 'whsec_test')).toBe(true)
    expect(verifyAutumnWebhook(Buffer.from(JSON.stringify(JSON.parse(raw.toString()))), signature, 'whsec_test')).toBe(false)
  })

  test('validates Svix signatures from Autumn webhook headers', () => {
    const raw = Buffer.from('{"event" : "billing.updated", "spacing" : true}')
    const id = 'msg_test'
    const timestamp = '1760000000'
    const secret = `whsec_${Buffer.from('svix_secret_test').toString('base64')}`
    const signedContent = `${id}.${timestamp}.${raw.toString('utf8')}`
    const signature = `v1,${createHmac('sha256', Buffer.from('svix_secret_test')).update(signedContent).digest('base64')}`

    expect(verifyAutumnWebhook(raw, signature, secret, { svixId: id, svixTimestamp: timestamp })).toBe(true)
    expect(verifyAutumnWebhook(Buffer.from('{}'), signature, secret, { svixId: id, svixTimestamp: timestamp })).toBe(false)
  })
})
