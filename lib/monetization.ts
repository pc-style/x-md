import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const AUTUMN_API_BASE = process.env.AUTUMN_API_BASE ?? 'https://api.useautumn.com/v1'
export const AUTUMN_SOCIAL_CREDITS_FEATURE_ID = 'social_credits'
export const API_KEY_PREFIX = 'xmd_'

export const PREMIUM_FEATURES = {
  quote_expansion: {
    id: 'quote_expansion',
    label: 'Quote-post expansion',
    credits: 1,
  },
  obsidian_templates: {
    id: 'obsidian_templates',
    label: 'Obsidian social note templates',
    credits: 1,
  },
  thread_briefing: {
    id: 'thread_briefing',
    label: 'Thread briefing mode',
    credits: 3,
  },
  context_safe_mode: {
    id: 'context_safe_mode',
    label: 'Context-window safe mode',
    credits: 3,
  },
  cross_platform_parser: {
    id: 'cross_platform_parser',
    label: 'Cross-platform social parser',
    credits: 3,
  },
  jsonld_bulk_export: {
    id: 'jsonld_bulk_export',
    label: 'Social archive JSON-LD bulk/export',
    credits: 5,
  },
  author_dossier: {
    id: 'author_dossier',
    label: 'Author dossier',
    credits: 10,
  },
} as const

export type PremiumFeatureId = keyof typeof PREMIUM_FEATURES

export type ApiKeyRecord = {
  keyHash: string
  userId: string
  revokedAt?: number | null
  label?: string
}

export class MonetizationError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'MonetizationError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export function isPremiumFeatureId(value: string | null | undefined): value is PremiumFeatureId {
  return !!value && Object.hasOwn(PREMIUM_FEATURES, value)
}

export function getPremiumFeature(value: string): (typeof PREMIUM_FEATURES)[PremiumFeatureId] {
  if (!isPremiumFeatureId(value)) {
    throw new MonetizationError(400, 'invalid_feature', `Unknown premium feature: ${value}`)
  }
  return PREMIUM_FEATURES[value]
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex')
}

export function createApiKey(): { apiKey: string; keyHash: string; tokenPreview: string } {
  const apiKey = `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`
  return {
    apiKey,
    keyHash: hashApiKey(apiKey),
    tokenPreview: `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`,
  }
}

export function extractBearerToken(authorization: string | string[] | undefined): string | null {
  const value = Array.isArray(authorization) ? authorization[0] : authorization
  if (!value) return null
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || null
}

export function verifyApiKeyHash(apiKey: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashApiKey(apiKey), 'hex')
  const expected = Buffer.from(expectedHash, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export async function resolveApiKeyOwner(
  apiKey: string | null,
  records: ApiKeyRecord[],
): Promise<string | null> {
  if (!apiKey?.startsWith(API_KEY_PREFIX)) return null
  for (const record of records) {
    if (record.revokedAt) continue
    if (verifyApiKeyHash(apiKey, record.keyHash)) return record.userId
  }
  return null
}

export type AutumnCheckResponse = {
  allowed?: boolean
  customerId?: string
  customer_id?: string
  balance?: unknown
  code?: string
  message?: string
  error?: string
  [key: string]: unknown
}

export async function autumnFetch<T>(
  path: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const secretKey = process.env.AUTUMN_SECRET_KEY
  if (!secretKey) {
    throw new MonetizationError(
      500,
      'autumn_not_configured',
      'Premium billing is not configured on this deployment.',
    )
  }

  const response = await fetchImpl(`${AUTUMN_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  const json = text ? safeJson(text) : {}

  if (!response.ok) {
    throw new MonetizationError(
      response.status,
      String(json.code ?? json.error ?? 'autumn_error'),
      String(json.message ?? json.error ?? 'Autumn request failed.'),
      json,
    )
  }

  return json as T
}

export async function ensureAutumnCustomer(
  customerId: string,
  attrs: { email?: string | null; name?: string | null } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  return autumnFetch('/customers.get_or_create', {
    customerId,
    email: attrs.email ?? undefined,
    name: attrs.name ?? undefined,
  }, fetchImpl)
}

export async function checkPremiumAccess(
  customerId: string,
  featureId: PremiumFeatureId,
  fetchImpl: typeof fetch = fetch,
): Promise<AutumnCheckResponse> {
  const feature = PREMIUM_FEATURES[featureId]
  const response = await autumnFetch<AutumnCheckResponse>('/customers.check', {
    customerId,
    featureId: AUTUMN_SOCIAL_CREDITS_FEATURE_ID,
    requiredBalance: feature.credits,
  }, fetchImpl)

  if (!response.allowed) {
    throw new MonetizationError(
      402,
      'premium_credits_required',
      `${feature.label} requires ${feature.credits} social credit${feature.credits === 1 ? '' : 's'}.`,
      response,
    )
  }

  return response
}

export async function trackPremiumUsage(
  customerId: string,
  featureId: PremiumFeatureId,
  fetchImpl: typeof fetch = fetch,
): Promise<AutumnCheckResponse> {
  const feature = PREMIUM_FEATURES[featureId]
  return autumnFetch<AutumnCheckResponse>('/customers.track', {
    customerId,
    featureId: AUTUMN_SOCIAL_CREDITS_FEATURE_ID,
    value: feature.credits,
    eventName: feature.id,
  }, fetchImpl)
}

export async function checkAndTrackPremiumUsage(
  customerId: string,
  featureId: PremiumFeatureId,
  fetchImpl: typeof fetch = fetch,
): Promise<AutumnCheckResponse> {
  const feature = PREMIUM_FEATURES[featureId]
  const response = await autumnFetch<AutumnCheckResponse>('/customers.check', {
    customerId,
    featureId: AUTUMN_SOCIAL_CREDITS_FEATURE_ID,
    requiredBalance: feature.credits,
    sendEvent: true,
    eventName: feature.id,
  }, fetchImpl)

  if (!response.allowed) {
    throw new MonetizationError(
      402,
      'premium_credits_required',
      `${feature.label} requires ${feature.credits} social credit${feature.credits === 1 ? '' : 's'}.`,
      response,
    )
  }

  return response
}

export async function createAutumnCheckout(
  customerId: string,
  planId: 'starter' | 'pro' | string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ customer_id?: string; customerId?: string; payment_url?: string; paymentUrl?: string } & Record<string, unknown>> {
  return autumnFetch('/billing.attach', { customerId, planId }, fetchImpl)
}

export async function openAutumnCustomerPortal(
  customerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ url?: string; customer_portal_url?: string; customerPortalUrl?: string } & Record<string, unknown>> {
  return autumnFetch('/billing.open_customer_portal', { customerId }, fetchImpl)
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  } catch {
    return { error: text }
  }
}
