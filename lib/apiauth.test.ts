import { beforeEach, describe, expect, test, vi } from 'vitest'
import { apiKeyRequired, callerHeaders, keyRequirementFailure, resolveCaller } from './apiauth.js'
import { createApiKey, getApiKey } from './apikeys.js'
import { resetKv } from './kv.js'

beforeEach(() => {
  resetKv()
  vi.restoreAllMocks()
})

describe('resolveCaller', () => {
  test('anonymous, valid and invalid outcomes', async () => {
    const { secret, record } = await createApiKey('amy', 12)
    const anon = await resolveCaller({ 'x-real-ip': '9.9.9.9' })
    expect(anon).toMatchObject({ status: 'anonymous', caller: { kind: 'public', ip: '9.9.9.9' } })
    expect(callerHeaders(anon)).toEqual({ 'X-Api-Key-Status': 'anonymous' })

    const valid = await resolveCaller({ authorization: `Bearer ${secret}` })
    expect(valid).toMatchObject({ status: 'valid', caller: { kind: 'key', id: record.id, limit: 12 } })
    expect(callerHeaders(valid)).toEqual({ 'X-Api-Key-Status': 'valid', 'Cache-Control': 'private, no-store' })
    expect((await getApiKey(record.id))?.lastUsedAt).toBeTypeOf('number') // touched, and awaited

    // Only Authorization is honored; a header the CDN would cache on is ignored.
    expect((await resolveCaller({ 'x-api-key': secret })).status).toBe('anonymous')
    expect((await resolveCaller({ authorization: 'Bearer xmd_wrong' })).status).toBe('invalid')
  })

  test('a key store outage degrades the caller to public instead of failing the request', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
    vi.stubEnv('KV_REST_API_TOKEN', 'tok')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))
    resetKv()
    const result = await resolveCaller({ authorization: 'Bearer xmd_anything', 'x-real-ip': '1.1.1.1' })
    expect(result).toMatchObject({ status: 'unverified', caller: { kind: 'public', ip: '1.1.1.1' } })
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })
})

describe('private mode', () => {
  const previous = process.env.X_MD_REQUIRE_API_KEY
  beforeEach(() => { process.env.X_MD_REQUIRE_API_KEY = previous })

  test('is off unless X_MD_REQUIRE_API_KEY is set, then only a valid key passes', async () => {
    delete process.env.X_MD_REQUIRE_API_KEY
    expect(apiKeyRequired()).toBe(false)
    const anon = await resolveCaller({ 'x-real-ip': '9.9.9.9' })
    expect(keyRequirementFailure(anon)).toBeUndefined()

    process.env.X_MD_REQUIRE_API_KEY = '1'
    expect(apiKeyRequired()).toBe(true)
    expect(keyRequirementFailure(anon)).toMatch(/requires an API key/)
    const { secret } = await createApiKey('leo', 60)
    const valid = await resolveCaller({ authorization: `Bearer ${secret}` })
    expect(keyRequirementFailure(valid)).toBeUndefined()
    const invalid = await resolveCaller({ authorization: 'Bearer nope' })
    expect(keyRequirementFailure(invalid)).toMatch(/requires an API key/)
    expect(keyRequirementFailure({ ...anon, status: 'unverified' })).toMatch(/store is unavailable/)
    delete process.env.X_MD_REQUIRE_API_KEY
  })
})
