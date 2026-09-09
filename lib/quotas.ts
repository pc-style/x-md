/**
 * Every request quota x.md enforces, in one place, so the sites that charge a
 * counter, the `RateLimit` headers that advertise it, and the docs that explain
 * it cannot drift apart.
 *
 * A leaf module on purpose: it imports nothing, so a handler can read the policy
 * table without dragging the search stack into its cold start.
 *
 * Policy names ship in response headers and the OpenAPI spec, so they are part
 * of the public contract: renaming one breaks any client that keys off it.
 */

/** What a policy's counter is keyed by. Published so agents can tell shared limits from personal ones. */
export type QuotaPartition = 'ip' | 'key'

/** One advertised quota: the `"name";q=<quota>;w=<window>` item of `RateLimit-Policy`. */
export interface QuotaPolicy {
  name: string
  /** `q`: units allocated per window. */
  quota: number
  /** `w`: window length in seconds. */
  windowSec: number
  partition: QuotaPartition
}

/**
 * Front-door allowance for every public API route, per client IP.
 *
 * Deliberately loose (10 rps sustained): it exists so every route can report a
 * quota an agent can pace against, not to shape traffic. Agent-readiness
 * scanners fire long bursts from one egress IP, and a self-inflicted 429 during
 * one costs far more than the limit protects.
 */
export const API_IP: QuotaPolicy = { name: 'api-ip', quota: 600, windowSec: 60, partition: 'ip' }

/** Live-search burst gate (lib/browse.ts), charged only when a search misses the application cache. */
export const SEARCH_IP: QuotaPolicy = { name: 'search-ip', quota: 5, windowSec: 60, partition: 'ip' }
/** The same gate for a keyed caller; their real allowance is the 15-minute one below. */
export const SEARCH_KEY: QuotaPolicy = { name: 'search-key', quota: 30, windowSec: 60, partition: 'key' }

/**
 * Bulk imports (api/import.ts). One import can cost upstream a few hundred
 * timeline pages, so it is metered on its own, not as one ordinary read.
 */
export const IMPORT_IP: QuotaPolicy = { name: 'import-ip', quota: 10, windowSec: 15 * 60, partition: 'ip' }
export const IMPORT_KEY: QuotaPolicy = { name: 'import-key', quota: 60, windowSec: 15 * 60, partition: 'key' }

/** Window of the account-backed search pool (lib/xsearch.ts, lib/pool.ts). */
export const ACCOUNT_WINDOW_SEC = 15 * 60

/**
 * Fixed per-IP allowance for anonymous account-backed search, pinned to the
 * value the two-account pool produced so public limits do not move as accounts
 * are added; new capacity is reserved for API-key callers.
 */
export const ACCOUNT_IP: QuotaPolicy = { name: 'account-ip', quota: 10, windowSec: ACCOUNT_WINDOW_SEC, partition: 'ip' }

/** A key's own account-backed allowance. Only the name is fixed; the quota is the key's own. */
export const ACCOUNT_KEY_NAME = 'account-key'

export const accountKeyPolicy = (limit: number): QuotaPolicy => ({
  name: ACCOUNT_KEY_NAME,
  quota: limit,
  windowSec: ACCOUNT_WINDOW_SEC,
  partition: 'key',
})

/**
 * Counter keys. These strings are live in the shared store, so they must keep
 * reproducing exactly what the charge sites used before they moved here — a
 * typo silently resets everyone's in-flight allowance and, worse, decouples the
 * advertised state from the counter enforcement actually reads.
 */
export const apiIpKey = (ip: string): string => `api:ip:${ip || 'unknown'}`
export const searchIpKey = (ip: string): string => `search:ip:${ip}`
export const searchKeyKey = (id: string): string => `search:key:${id}`
export const importIpKey = (ip: string): string => `import:ip:${ip || 'unknown'}`
export const importKeyKey = (id: string): string => `import:key:${id}`
export const accountIpKey = (ip: string): string => `xsearch:ip:${ip || 'unknown'}`
export const accountKeyKey = (id: string): string => `xsearch:key:${id}`

/** The shared account pool. Never advertised per caller: its level is fleet health, not a personal quota. */
export const ACCOUNT_PUBLIC_COUNTER = 'xsearch:public'
