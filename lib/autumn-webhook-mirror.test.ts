import { describe, expect, test } from 'vitest'
import { parseAutumnBillingWebhook, summarizeBillingWebhook } from './autumn-webhook-mirror.js'

describe('Autumn webhook mirror', () => {
  test('parses billing.updated envelopes', () => {
    const raw = JSON.stringify({
      type: 'billing.updated',
      data: {
        object: 'billing.updated',
        customer_id: 'user_123',
        plan_changes: [
          {
            action: 'activated',
            subscription: {
              plan_id: 'starter',
              status: 'active',
            },
          },
        ],
      },
    })

    const event = parseAutumnBillingWebhook(raw)
    expect(event?.customer_id).toBe('user_123')
    expect(summarizeBillingWebhook(event!)).toMatchObject({
      handled: true,
      customerId: 'user_123',
      planId: 'starter',
      status: 'active',
    })
  })

  test('falls back to free when all plans expire', () => {
    const summary = summarizeBillingWebhook({
      customer_id: 'user_123',
      plan_changes: [
        {
          action: 'expired',
          subscription: { plan_id: 'starter', status: 'expired' },
        },
      ],
    })

    expect(summary).toMatchObject({
      handled: true,
      customerId: 'user_123',
      planId: 'free',
      status: 'expired',
    })
  })
})
