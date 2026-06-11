import type { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api.js'

export type AutumnBillingWebhook = {
  type?: string
  data?: AutumnBillingUpdated
  customer_id?: string
  plan_changes?: AutumnPlanChange[]
  [key: string]: unknown
}

export type AutumnBillingUpdated = {
  object?: string
  customer_id?: string
  entity_id?: string | null
  plan_changes?: AutumnPlanChange[]
  tags?: string[]
  [key: string]: unknown
}

export type AutumnPlanChange = {
  action?: 'activated' | 'scheduled' | 'updated' | 'expired'
  subscription?: {
    plan_id?: string
    status?: string
    past_due?: boolean
    [key: string]: unknown
  } | null
  purchase?: {
    plan_id?: string
    status?: string
    [key: string]: unknown
  } | null
  [key: string]: unknown
}

export type AutumnWebhookMirrorResult = {
  handled: boolean
  customerId?: string
  planId?: string
  status?: string
  reason?: string
}

export function parseAutumnBillingWebhook(rawBody: Buffer | string): AutumnBillingUpdated | null {
  try {
    const payload = JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')) as AutumnBillingWebhook
    if (payload.type === 'billing.updated' && payload.data) return payload.data
    if (payload.data?.object === 'billing.updated') return payload.data
    if (payload.object === 'billing.updated' || Array.isArray(payload.plan_changes)) {
      return payload as AutumnBillingUpdated
    }
    return null
  } catch {
    return null
  }
}

export function summarizeBillingWebhook(event: AutumnBillingUpdated): AutumnWebhookMirrorResult {
  const customerId = event.customer_id
  if (!customerId) return { handled: false, reason: 'missing_customer_id' }

  const changes = Array.isArray(event.plan_changes) ? event.plan_changes : []
  const activeSubscription = changes.find(
    (change) => change.action === 'activated' && change.subscription?.status === 'active',
  )?.subscription
    ?? changes.find((change) => change.subscription?.status === 'active')?.subscription
    ?? changes.find((change) => change.subscription?.status === 'trialing')?.subscription

  const activePurchase = changes.find(
    (change) => change.action === 'activated' && change.purchase?.status === 'active',
  )?.purchase
    ?? changes.find((change) => change.purchase?.status === 'active')?.purchase

  const planId = activeSubscription?.plan_id ?? activePurchase?.plan_id
  const status = activeSubscription?.status ?? activePurchase?.status

  if (!planId && changes.every((change) => change.action === 'expired')) {
    return {
      handled: true,
      customerId,
      planId: 'free',
      status: 'expired',
      reason: 'all_plans_expired',
    }
  }

  if (!planId) return { handled: false, customerId, reason: 'no_active_plan' }

  return { handled: true, customerId, planId, status: status ?? 'active' }
}

export async function mirrorAutumnBillingWebhook(
  convex: ConvexHttpClient,
  serverSecret: string | undefined,
  rawBody: Buffer | string,
): Promise<AutumnWebhookMirrorResult> {
  const event = parseAutumnBillingWebhook(rawBody)
  if (!event) return { handled: false, reason: 'unsupported_event' }

  const summary = summarizeBillingWebhook(event)
  if (!summary.handled || !summary.customerId) return summary

  await convex.mutation(api.billing.upsertCustomerMapping, {
    userId: summary.customerId,
    autumnCustomerId: summary.customerId,
    planId: summary.planId,
    status: summary.status,
    raw: event,
    serverSecret,
  })

  return summary
}
