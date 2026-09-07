/**
 * Admin authentication for the key-management dashboard. A single bearer token
 * from `X_MD_ADMIN_TOKEN` guards every admin endpoint. Absent env var → locked.
 */
import { timingSafeEqual } from 'node:crypto'
import { presentedApiKey } from './http.js'

type HeaderBag = Record<string, string | string[] | undefined>

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Whether admin endpoints are usable at all (token configured server-side). */
export function adminConfigured(): boolean {
  return !!process.env.X_MD_ADMIN_TOKEN
}

/** Constant-time check of the presented admin bearer token. */
export function adminAuthorized(headers: HeaderBag): boolean {
  const token = process.env.X_MD_ADMIN_TOKEN
  if (!token) return false
  const presented = presentedApiKey(headers)
  return !!presented && safeEqual(presented, token)
}
