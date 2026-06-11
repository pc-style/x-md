import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolveAuthContext, syncUserToBackends } from '../lib/auth.js'
import { createAutumnCheckout, ensureAutumnCustomer, MonetizationError, openAutumnCustomerPortal } from '../lib/monetization.js'

const BILLING_PLANS = new Set(['starter', 'pro'])

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const auth = await resolveAuthContext(req.headers)
    if (!auth.userId) {
      return res.status(401).json({ error: 'Sign in to manage billing.', code: 'authentication_required' })
    }

    await syncUserToBackends(auth)
    await ensureAutumnCustomer(auth.userId, { email: auth.email, name: auth.name })

    const action = String(req.query.action ?? req.body?.action ?? 'checkout')

    if (action === 'portal') {
      const portal = await openAutumnCustomerPortal(auth.userId)
      const url = portal.url ?? portal.customer_portal_url ?? portal.customerPortalUrl
      return res.status(200).json({ url, portal })
    }

    const planId = String(req.query.plan ?? req.body?.planId ?? req.body?.plan ?? '')
    if (!BILLING_PLANS.has(planId)) {
      return res.status(400).json({ error: '`plan` must be `starter` or `pro`.', code: 'invalid_plan' })
    }

    const checkout = await createAutumnCheckout(auth.userId, planId)
    const url = checkout.payment_url ?? checkout.paymentUrl
    return res.status(200).json({ url, checkout })
  } catch (error) {
    if (error instanceof MonetizationError) {
      return res.status(error.status).json({ error: error.message, code: error.code })
    }
    console.error(error)
    return res.status(500).json({ error: 'Billing request failed', code: 'billing_error' })
  }
}

function setCorsHeaders(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type')
}
