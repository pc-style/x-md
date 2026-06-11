import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkAndTrackPremiumUsage,
  createApiKey,
  createAutumnCheckout,
  extractBearerToken,
  hashApiKey,
  MonetizationError,
  resolveApiKeyOwner,
  verifyApiKeyHash,
} from './monetization.js'

const ORIGINAL_AUTUMN_KEY = process.env.AUTUMN_SECRET_KEY

function restoreEnv() {
  if (ORIGINAL_AUTUMN_KEY === undefined) delete process.env.AUTUMN_SECRET_KEY
  else process.env.AUTUMN_SECRET_KEY = ORIGINAL_AUTUMN_KEY
}

afterEach(() => {
  restoreEnv()
  vi.restoreAllMocks()
})

describe('API key helpers', () => {
  test('creates xmd-prefixed keys and verifies hashes without storing plaintext', () => {
    const { apiKey, keyHash } = createApiKey()

    expect(apiKey).toMatch(/^xmd_/)
    expect(keyHash).toBe(hashApiKey(apiKey))
    expect(keyHash).not.toContain(apiKey)
    expect(verifyApiKeyHash(apiKey, keyHash)).toBe(true)
    expect(verifyApiKeyHash(`${apiKey}nope`, keyHash)).toBe(false)
  })

  test('extracts bearer tokens', () => {
    expect(extractBearerToken('Bearer xmd_test')).toBe('xmd_test')
    expect(extractBearerToken('basic no')).toBeNull()
    expect(extractBearerToken(undefined)).toBeNull()
  })

  test('resolves active API key owner and ignores revoked records', async () => {
    const { apiKey, keyHash } = createApiKey()

    await expect(resolveApiKeyOwner(apiKey, [{ keyHash, userId: 'user_123' }])).resolves.toBe('user_123')
    await expect(resolveApiKeyOwner(apiKey, [{ keyHash, userId: 'user_123', revokedAt: Date.now() }])).resolves.toBeNull()
  })
})

describe('Autumn premium checks', () => {
  test('calls Autumn check/track exactly once with required social credit balance', async () => {
    process.env.AUTUMN_SECRET_KEY = 'am_sk_test'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: true, balance: { remaining: 249 } }), { status: 200 }),
    )

    await expect(checkAndTrackPremiumUsage('user_123', 'thread_briefing', fetchMock)).resolves.toMatchObject({ allowed: true })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.useautumn.com/v1/check')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer am_sk_test' }),
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      customer_id: 'user_123',
      feature_id: 'social_credits',
      required_balance: 3,
      send_event: true,
      event_name: 'thread_briefing',
    })
  })

  test('requests checkout with redirectMode always', async () => {
    process.env.AUTUMN_SECRET_KEY = 'am_sk_test'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ payment_url: 'https://checkout.example' }), { status: 200 }),
    )

    await createAutumnCheckout('user_123', 'starter', fetchMock)

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      customer_id: 'user_123',
      plan_id: 'starter',
      redirect_mode: 'always',
    })
  })

  test('turns Autumn denial into a stable 402 paywall error', async () => {
    process.env.AUTUMN_SECRET_KEY = 'am_sk_test'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ allowed: false, balance: { remaining: 0 } }), { status: 200 }),
    )

    await expect(checkAndTrackPremiumUsage('user_123', 'author_dossier', fetchMock)).rejects.toMatchObject({
      status: 402,
      code: 'premium_credits_required',
    } satisfies Partial<MonetizationError>)
  })
})
