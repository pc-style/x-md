import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolveAuthContext, syncUserToBackends } from '../lib/auth.js'
import { ensureAutumnCustomer, MonetizationError } from '../lib/monetization.js'

type AutumnProduct = {
  id?: string
  name?: string
  status?: string
  [key: string]: unknown
}

type AutumnCustomer = {
  id?: string
  email?: string | null
  name?: string | null
  products?: AutumnProduct[]
  features?: Record<string, { balance?: number; included_usage?: number; includedUsage?: number; [key: string]: unknown }>
  [key: string]: unknown
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res)

  if (req.method === 'OPTIONS') {
    return res.status(204).end()
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const auth = await resolveAuthContext(req.headers)
    if (!auth.userId || (auth.authMethod !== 'clerk' && auth.authMethod !== 'api_key')) {
      return res.status(401).json({ error: 'Sign in to view your account.', code: 'authentication_required' })
    }

    await syncUserToBackends(auth)

    let customer: AutumnCustomer | null = null
    let billingError: { code: string; message: string } | null = null
    try {
      const raw = await ensureAutumnCustomer(auth.userId, { email: auth.email, name: auth.name }) as Record<string, unknown>
      customer = (raw?.customer ?? raw) as AutumnCustomer
    } catch (error) {
      if (error instanceof MonetizationError) {
        billingError = { code: error.code, message: error.message }
      } else {
        throw error
      }
    }

    const products = Array.isArray(customer?.products) ? customer.products : []
    const activePlan = products.find((p) => p.status === 'active' || p.status === 'trialing') ?? products[0] ?? null
    const creditsFeature = customer?.features?.social_credits ?? null
    const credits = creditsFeature
      ? {
          balance: typeof creditsFeature.balance === 'number' ? creditsFeature.balance : null,
          includedUsage: typeof creditsFeature.included_usage === 'number'
            ? creditsFeature.included_usage
            : typeof creditsFeature.includedUsage === 'number'
              ? creditsFeature.includedUsage
              : null,
        }
      : null

    return res.status(200).json({
      user: { id: auth.userId, email: auth.email ?? null, name: auth.name ?? null },
      plan: activePlan ? { id: activePlan.id ?? null, name: activePlan.name ?? null, status: activePlan.status ?? null } : null,
      products: products.map((p) => ({ id: p.id ?? null, name: p.name ?? null, status: p.status ?? null })),
      credits,
      billingError,
    })
  } catch (error) {
    if (error instanceof MonetizationError) {
      return res.status(error.status).json({ error: error.message, code: error.code })
    }
    console.error(error)
    return res.status(500).json({ error: 'Account request failed', code: 'account_error' })
  }
}

function setCorsHeaders(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type')
}
