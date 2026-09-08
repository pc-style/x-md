import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ACCOUNT_IP, API_IP, SEARCH_IP, searchIpKey } from './quotas.js'
import { rateLimit, resetRateLimits } from './ratelimit.js'
import {
  applyExhaustedQuota,
  applyQuotaPolicyOnly,
  applyRequestQuota,
  chargeRequestQuota,
  policyField,
  quotaPolicies,
  rateLimitHeaders,
  setRateLimitHeaders,
  setRetryAfter,
  stateField,
  tightestState,
  type QuotaState,
} from './ratelimit-headers.js'

// Exactly on a minute and a 15-minute boundary, so every window's reset is a whole window.
const NOW = new Date('2026-09-06T12:00:00Z')

function sink() {
  const headers: Record<string, string> = {}
  return { headers, setHeader: (name: string, value: string) => void (headers[name] = value) }
}

const state = (over: Partial<QuotaState> = {}): QuotaState => ({
  name: 'api-ip', quota: 600, windowSec: 60, partition: 'ip', remaining: 599, resetSec: 43, ...over,
})

beforeEach(() => {
  resetRateLimits()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('structured fields', () => {
  test('serialises policies and state as RFC 9651 item lists', () => {
    expect(policyField([API_IP, SEARCH_IP])).toBe('"api-ip";q=600;w=60, "search-ip";q=5;w=60')
    expect(stateField([state(), state({ name: 'search-ip', quota: 5, remaining: 5, resetSec: 43 })]))
      .toBe('"api-ip";r=599;t=43, "search-ip";r=5;t=43')
  })

  test('quotes policy names as sf-strings, escaping and dropping what the grammar forbids', () => {
    expect(policyField([{ name: 'we"ird\\name', quota: 1, windowSec: 1, partition: 'ip' }]))
      .toBe('"we\\"ird\\\\name";q=1;w=1')
    expect(policyField([{ name: 'café-été', quota: 1, windowSec: 1, partition: 'ip' }])).toBe('"caf-t";q=1;w=1')
  })

  test('clamps every parameter to a non-negative integer', () => {
    expect(stateField([state({ remaining: -3, resetSec: 2.7 })])).toBe('"api-ip";r=0;t=2')
    expect(policyField([{ name: 'x', quota: Number.NaN, windowSec: -5, partition: 'ip' }])).toBe('"x";q=0;w=0')
  })

  test('the compatibility triple describes the policy closest to exhaustion', () => {
    const states = [state(), state({ name: 'search-ip', quota: 5, remaining: 5, resetSec: 43 })]
    expect(tightestState(states)?.name).toBe('search-ip')
    expect(rateLimitHeaders(states)).toEqual({
      'RateLimit-Policy': '"api-ip";q=600;w=60, "search-ip";q=5;w=60',
      RateLimit: '"api-ip";r=599;t=43, "search-ip";r=5;t=43',
      'RateLimit-Limit': '5',
      'RateLimit-Remaining': '5',
      'RateLimit-Reset': '43',
    })
  })

  test('an equal remaining is broken by the sooner reset', () => {
    const soon = state({ name: 'soon', remaining: 5, resetSec: 10 })
    expect(tightestState([state({ name: 'later', remaining: 5, resetSec: 900 }), soon])).toBe(soon)
  })

  test('writes nothing when there is no quota to advertise', () => {
    const res = sink()
    setRateLimitHeaders(res, [])
    expect(res.headers).toEqual({})
  })

  test('Retry-After never says zero seconds, which reads as "retry now"', () => {
    const res = sink()
    setRetryAfter(res, 0)
    expect(res.headers['Retry-After']).toBe('1')
  })
})

describe('quotaPolicies', () => {
  test('read routes advertise the front door only', () => {
    expect(quotaPolicies('read', { ip: '1.2.3.4' })).toEqual([API_IP])
  })

  test('anonymous search adds the per-IP burst gate and account allowance', () => {
    expect(quotaPolicies('search', { ip: '1.2.3.4' }).map((p) => [p.name, p.quota, p.windowSec]))
      .toEqual([['api-ip', 600, 60], ['search-ip', 5, 60], ['account-ip', 10, 900]])
  })

  test('a key advertises its own allowance instead of the public one', () => {
    expect(quotaPolicies('search', { ip: '1.2.3.4', key: { id: 'k1', limit: 45 } }).map((p) => [p.name, p.quota, p.partition]))
      .toEqual([['api-ip', 600, 'ip'], ['search-key', 30, 'key'], ['account-key', 45, 'key']])
  })
})

describe('chargeRequestQuota', () => {
  test('charges the front door and reports it on the response', async () => {
    const first = await chargeRequestQuota('read', { ip: '1.2.3.4' })
    expect(first).toMatchObject({ allowed: true, degraded: false })
    expect(first.states).toEqual([{ ...API_IP, remaining: 599, resetSec: 60 }])

    const res = sink()
    applyRequestQuota(res, await chargeRequestQuota('read', { ip: '1.2.3.4' }))
    expect(res.headers).toEqual({
      'RateLimit-Policy': '"api-ip";q=600;w=60',
      RateLimit: '"api-ip";r=598;t=60',
      'RateLimit-Limit': '600',
      'RateLimit-Remaining': '598',
      'RateLimit-Reset': '60',
    })
  })

  test('reads the deeper search counters without charging them', async () => {
    const read = () => chargeRequestQuota('search', { ip: '1.2.3.4' })
    expect((await read()).states.map((s) => s.remaining)).toEqual([599, 5, 10])
    // Peeking twice must not move the gate the search layer will charge later.
    expect((await read()).states.map((s) => s.remaining)).toEqual([598, 5, 10])
    await rateLimit(searchIpKey('1.2.3.4'), SEARCH_IP.quota, SEARCH_IP.windowSec)
    expect((await read()).states.map((s) => s.remaining)).toEqual([597, 4, 10])
  })

  test('the triple tracks the tightest policy, not the front door', async () => {
    const res = sink()
    applyRequestQuota(res, await chargeRequestQuota('search', { ip: '1.2.3.4' }))
    expect(res.headers['RateLimit-Policy']).toBe('"api-ip";q=600;w=60, "search-ip";q=5;w=60, "account-ip";q=10;w=900')
    expect(res.headers['RateLimit']).toBe('"api-ip";r=599;t=60, "search-ip";r=5;t=60, "account-ip";r=10;t=900')
    expect(res.headers['RateLimit-Limit']).toBe('5')
    expect(res.headers['RateLimit-Reset']).toBe('60')
  })

  test('a counter-store outage still answers, with the full quota it is no longer enforcing', async () => {
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
    vi.stubEnv('KV_REST_API_TOKEN', 'tok')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))

    const quota = await chargeRequestQuota('search', { ip: '1.2.3.4' })
    expect(quota).toMatchObject({ allowed: true, degraded: true })
    expect(quota.states.map((s) => s.remaining)).toEqual([API_IP.quota, SEARCH_IP.quota, ACCOUNT_IP.quota])
    const res = sink()
    applyRequestQuota(res, quota)
    expect(res.headers['RateLimit']).toBe('"api-ip";r=600;t=60, "search-ip";r=5;t=60, "account-ip";r=10;t=900')
  })
})

describe('rejected requests', () => {
  test('report the exhausted policy at r=0, aligned with Retry-After, and never cache it', async () => {
    const quota = await chargeRequestQuota('search', { ip: '1.2.3.4' })
    const res = sink()
    applyExhaustedQuota(res, quota, SEARCH_IP.name, 17)
    expect(res.headers['RateLimit']).toBe('"api-ip";r=599;t=60, "search-ip";r=0;t=17, "account-ip";r=10;t=900')
    expect(res.headers['RateLimit-Limit']).toBe('5')
    expect(res.headers['RateLimit-Remaining']).toBe('0')
    expect(res.headers['RateLimit-Reset']).toBe('17')
    expect(res.headers['Retry-After']).toBe('17')
    // A shared cache keyed without the client IP would replay this 429 to callers who still have quota.
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.headers['Vercel-CDN-Cache-Control']).toBe('no-store')
  })

  test('an unattributed rejection leaves the measured state alone', async () => {
    const quota = await chargeRequestQuota('read', { ip: '1.2.3.4' })
    const res = sink()
    applyExhaustedQuota(res, quota, undefined, 30)
    expect(res.headers['RateLimit']).toBe('"api-ip";r=599;t=60')
    expect(res.headers['Retry-After']).toBe('30')
  })
})

describe('applyQuotaPolicyOnly', () => {
  test('an uncharged response advertises the policy but claims no state', () => {
    const res = sink()
    applyQuotaPolicyOnly(res, 'search', { ip: '1.2.3.4' })
    expect(res.headers).toEqual({ 'RateLimit-Policy': '"api-ip";q=600;w=60, "search-ip";q=5;w=60, "account-ip";q=10;w=900' })
  })
})
