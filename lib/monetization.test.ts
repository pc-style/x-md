import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  checkAndTrackPremiumUsage,
  createApiKey,
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
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.useautumn.com/v1/customers.check')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer am_sk_test' }),
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      customerId: 'user_123',
      featureId: 'social_credits',
      requiredBalance: 3,
      sendEvent: true,
      eventName: 'thread_briefing',
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
