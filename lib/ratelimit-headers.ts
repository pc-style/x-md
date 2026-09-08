/**
 * Rate-limit response headers, and the per-request bookkeeping that fills them in.
 *
 * Two forms go out together. `RateLimit-Policy` and `RateLimit` are the RFC 9651
 * structured fields specified by draft-ietf-httpapi-ratelimit-headers-11;
 * `RateLimit-Limit` / `-Remaining` / `-Reset` are the pre-standard triple that
 * the draft records as existing practice and that most clients still read.
 *
 * The quotas themselves are enforced deep in the request path (lib/browse.ts,
 * lib/xsearch.ts) long after the handler has decided what to send, so a handler
 * cannot learn its caller's position by watching them go by. `chargeRequestQuota`
 * therefore charges the front-door counter and *peeks* the deeper ones — no
 * charge, one extra round-trip — purely so the response can describe them.
 *
 * Enforcement never reads any of this back: every admission decision is a
 * `rateLimit()` call against the shared counter. A stale or absent header can
 * mislead a client's self-pacing, never x.md's own throttling.
 */
import type { HeaderWriter } from './http.js'
import {
  ACCOUNT_IP,
  ACCOUNT_KEY_NAME,
  API_IP,
  SEARCH_IP,
  SEARCH_KEY,
  accountIpKey,
  accountKeyKey,
  accountKeyPolicy,
  apiIpKey,
  searchIpKey,
  searchKeyKey,
  type QuotaPolicy,
} from './quotas.js'
import { peekRateLimits, rateLimit, windowClock } from './ratelimit.js'

/** A policy plus this caller's position in it: the `"name";r=<remaining>;t=<reset>` item of `RateLimit`. */
export interface QuotaState extends QuotaPolicy {
  /** `r`: units left in the current window. */
  remaining: number
  /** `t`: seconds until this policy's window resets. */
  resetSec: number
}

/** Which deeper allowances a route can spend on top of the front door. */
export type QuotaScope = 'read' | 'search'

export interface QuotaCaller {
  ip: string
  /** Present only for a verified API key; anonymous callers are limited by IP. */
  key?: { id: string; limit: number }
}

export interface RequestQuota {
  /** False when the front-door allowance is spent; the handler answers 429. */
  allowed: boolean
  /** Seconds until the front-door window resets, for `Retry-After`. */
  retryAfter: number
  /** Every policy to advertise, front door first. */
  states: QuotaState[]
  /** A counter could not be read, so the reported state is the fail-open assumption. */
  degraded: boolean
}

const nonNegative = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0)

/** RFC 9651 sf-string: printable ASCII only, with `\` and `"` escaped. */
function sfString(value: string): string {
  return `"${value.replace(/[^\x20-\x7e]/g, '').replace(/(["\\])/g, '\\$1')}"`
}

/** `"name";q=<quota>;w=<window>` items, comma separated. */
export function policyField(policies: readonly QuotaPolicy[]): string {
  return policies.map((p) => `${sfString(p.name)};q=${nonNegative(p.quota)};w=${nonNegative(p.windowSec)}`).join(', ')
}

/** `"name";r=<remaining>;t=<reset>` items, comma separated. */
export function stateField(states: readonly QuotaState[]): string {
  return states.map((s) => `${sfString(s.name)};r=${nonNegative(s.remaining)};t=${nonNegative(s.resetSec)}`).join(', ')
}

/**
 * The policy a single-value client should pace against: the one closest to
 * exhaustion, tie-broken by the sooner reset. The compatibility triple can only
 * describe one policy, so it describes this one.
 */
export function tightestState(states: readonly QuotaState[]): QuotaState | undefined {
  return states.reduce<QuotaState | undefined>((best, state) => {
    if (!best) return state
    if (state.remaining !== best.remaining) return state.remaining < best.remaining ? state : best
    return state.resetSec < best.resetSec ? state : best
  }, undefined)
}

/** The full header set for a measured request. Empty when there is nothing to advertise. */
export function rateLimitHeaders(states: readonly QuotaState[]): Record<string, string> {
  const tightest = tightestState(states)
  if (!tightest) return {}
  return {
    'RateLimit-Policy': policyField(states),
    RateLimit: stateField(states),
    'RateLimit-Limit': String(nonNegative(tightest.quota)),
    'RateLimit-Remaining': String(nonNegative(tightest.remaining)),
    'RateLimit-Reset': String(nonNegative(tightest.resetSec)),
  }
}

/** Advertise the policies without claiming a state, for responses that were never charged. */
export function setRateLimitPolicy(res: HeaderWriter, policies: readonly QuotaPolicy[]): void {
  if (policies.length === 0) return
  res.setHeader('RateLimit-Policy', policyField(policies))
}

/** Policy, structured state, and the compatibility triple. */
export function setRateLimitHeaders(res: HeaderWriter, states: readonly QuotaState[]): void {
  for (const [name, value] of Object.entries(rateLimitHeaders(states))) res.setHeader(name, value)
}

/** RFC 9110 delta-seconds companion for 429 and 503. Never `0`: that reads as "retry now". */
export function setRetryAfter(res: HeaderWriter, seconds: number): void {
  res.setHeader('Retry-After', String(Math.max(1, nonNegative(seconds))))
}

/**
 * Keep a rejection out of every shared cache.
 *
 * `RateLimit` state is per client IP and no `Vary` value can express that, so a
 * CDN that stores one caller's `r=0` would replay it to callers who still have
 * quota — a throttle a client would honour for the life of the entry. Successful
 * responses stay cacheable (a cache hit never reaches a counter, so it is free,
 * and its replayed state is stale rather than harmful — the draft tells clients
 * to ignore RateLimit fields on any response with a positive `Age`). An
 * exhausted state gets no such benefit of the doubt.
 */
export function setUncacheable(res: HeaderWriter): void {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
}

/** The policies that apply to `scope` for `caller`, front door first. */
export function quotaPolicies(scope: QuotaScope, caller: QuotaCaller): QuotaPolicy[] {
  const policies: QuotaPolicy[] = [API_IP]
  if (scope !== 'search') return policies
  policies.push(caller.key ? SEARCH_KEY : SEARCH_IP)
  policies.push(caller.key ? accountKeyPolicy(caller.key.limit) : ACCOUNT_IP)
  return policies
}

/** The counter a peeked policy reads. Must match the key its charge site uses. */
function counterFor(policy: QuotaPolicy, caller: QuotaCaller): string {
  switch (policy.name) {
    case SEARCH_KEY.name:
      return searchKeyKey(caller.key?.id ?? 'unknown')
    case SEARCH_IP.name:
      return searchIpKey(caller.ip)
    case ACCOUNT_KEY_NAME:
      return accountKeyKey(caller.key?.id ?? 'unknown')
    default:
      return accountIpKey(caller.ip)
  }
}

/**
 * Charge one front-door hit and read the deeper counters. A store outage
 * degrades to "allowed, full quota" — the same fail-open posture as the rest of
 * the request path — so the headers stay present and stay honest about the
 * throttling actually in effect, which during an outage is none.
 *
 * The charge and the peek touch different keys, so they go to the store
 * together: this runs in front of every API request, and a serialised second
 * round-trip would add its full latency to each one. A read-only route has no
 * deeper policies, and `peekRateLimits([])` answers without a round-trip at all.
 */
export async function chargeRequestQuota(scope: QuotaScope, caller: QuotaCaller): Promise<RequestQuota> {
  const [front = API_IP, ...deeper] = quotaPolicies(scope, caller)
  const [verdict, counts] = await Promise.all([
    rateLimit(apiIpKey(caller.ip), API_IP.quota, API_IP.windowSec),
    peekRateLimits(deeper.map((policy) => ({ key: counterFor(policy, caller), windowSec: policy.windowSec }))).catch((error: unknown) => {
      console.warn(`[ratelimit-headers] counter peek failed, reporting full quota: ${String(error).slice(0, 120)}`)
      return undefined
    }),
  ])
  const states: QuotaState[] = [{ ...front, remaining: verdict.remaining, resetSec: verdict.retryAfter }]
  for (const [index, policy] of deeper.entries()) {
    const used = counts?.[index] ?? 0
    states.push({ ...policy, remaining: Math.max(0, policy.quota - used), resetSec: windowClock(policy.windowSec).remainingSec })
  }

  return { allowed: verdict.allowed, retryAfter: verdict.retryAfter, states, degraded: verdict.degraded || counts === undefined }
}

/** Advertise a charged request's quota. Safe to call more than once; the last call wins. */
export function applyRequestQuota(res: HeaderWriter, quota: RequestQuota): void {
  setRateLimitHeaders(res, quota.states)
}

/**
 * Advertise the quota of a request a limit just rejected, with `policy` forced to
 * `r=0` and its reset aligned to `Retry-After` (the draft asks the two to agree,
 * and tells clients to prefer `Retry-After` when they disagree). The deeper
 * limits charge long after the peek, so this is the only place their exhaustion
 * is known; without it a 429 would report the quota it had one request ago.
 */
export function applyExhaustedQuota(res: HeaderWriter, quota: RequestQuota, policy: string | undefined, retryAfter: number): void {
  const reset = Math.max(1, nonNegative(retryAfter))
  setRateLimitHeaders(res, policy ? quota.states.map((s) => (s.name === policy ? { ...s, remaining: 0, resetSec: reset } : s)) : quota.states)
  setRetryAfter(res, reset)
  setUncacheable(res)
}

/** Preflight and other uncharged responses still say what the policies are. */
export function applyQuotaPolicyOnly(res: HeaderWriter, scope: QuotaScope, caller: QuotaCaller): void {
  setRateLimitPolicy(res, quotaPolicies(scope, caller))
}
