/**
 * Resolve who is calling a browse endpoint, shared by the Vercel function and
 * the Vite dev middleware so both behave identically.
 *
 * Only `Authorization: Bearer` is accepted. Vercel's CDN never caches requests
 * that carry an Authorization header, so keyed responses (and the status header
 * describing them) can never be served from cache to another caller.
 */
import { resolveApiKey, touchApiKey, type ApiKeyRecord } from './apikeys.js'
import { presentedApiKey } from './http.js'
import { clientIp } from './ratelimit.js'
import type { SearchCaller } from './xsearch.js'

export type ApiKeyStatus = 'valid' | 'anonymous' | 'invalid' | 'unverified'

export interface ResolvedCaller {
  caller: SearchCaller
  status: ApiKeyStatus
  record?: ApiKeyRecord
  ip: string
}

/**
 * Identify the caller. A key that cannot be verified because the store is down
 * degrades to a public caller (`unverified`) instead of failing the request,
 * matching the fail-open posture of the rest of the request path.
 */
export async function resolveCaller(headers: Record<string, string | string[] | undefined>): Promise<ResolvedCaller> {
  const ip = clientIp(headers)
  const presented = presentedApiKey(headers)
  if (!presented) return { caller: { kind: 'public', ip }, status: 'anonymous', ip }
  let resolved: Awaited<ReturnType<typeof resolveApiKey>>
  try {
    resolved = await resolveApiKey(presented)
  } catch (error) {
    console.warn(`[apiauth] key store unavailable, treating caller as public: ${String(error).slice(0, 120)}`)
    return { caller: { kind: 'public', ip }, status: 'unverified', ip }
  }
  if (resolved === 'invalid' || resolved === null) return { caller: { kind: 'public', ip }, status: 'invalid', ip }
  // Awaited (cheap, throttled to one write per 30s) so a fast response cannot
  // freeze the function before the activity stamp lands; idle detection depends on it.
  await touchApiKey(resolved)
  return { caller: { kind: 'key', id: resolved.id, limit: resolved.limitPer15m }, status: 'valid', record: resolved, ip }
}

/** Response headers describing the key outcome. Keyed responses are also marked private. */
export function callerHeaders(resolved: ResolvedCaller): Record<string, string> {
  const headers: Record<string, string> = { 'X-Api-Key-Status': resolved.status }
  if (resolved.status === 'valid') headers['Cache-Control'] = 'private, no-store'
  return headers
}
