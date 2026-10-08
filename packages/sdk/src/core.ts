// Shared by the plain and Effect clients: request building, retry timing and input parsing.

import { operations, type ErrorCode, type OperationId } from './generated/types.js'

/**
 * Input the SDK rejects before sending, with the problem code the API uses for it.
 * An empty path segment cannot go to the API: `/profiles//followers` is normalized
 * by a redirect to `/profiles/followers`, the profile of an account named followers.
 */
export class InputError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export const DEFAULT_BASE_URL = 'https://mdfromx.com'
export const API_KEY_ENV = 'MDFROMX_API_KEY'
export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

export type Format = 'json' | 'markdown' | 'ndjson'

export const ACCEPT: Record<Format, string> = {
  json: 'application/json',
  markdown: 'text/markdown',
  ndjson: 'application/x-ndjson',
}

/** Retry policy for 429 and 503 answers. `false` turns retries off. */
export type RetryOptions = false | {
  /** Retries after the first attempt. Default 2. */
  readonly maxRetries?: number
  /** Give up instead of waiting longer than this for one retry. Default 30000. */
  readonly maxDelayMs?: number
}

export interface ResolvedRetry {
  readonly maxRetries: number
  readonly maxDelayMs: number
}

export function resolveRetry(retry: RetryOptions | undefined): ResolvedRetry {
  if (retry === false) return { maxRetries: 0, maxDelayMs: 0 }
  return {
    maxRetries: retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    maxDelayMs: retry?.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
  }
}

/** A blank key means no key: never send `Authorization: Bearer ` with nothing after it. */
export const normalizeApiKey = (key: string | undefined): string | undefined => key?.trim() || undefined

/** The key from `MDFROMX_API_KEY` on Node, Bun and Deno; undefined in browsers. */
export function envApiKey(): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return normalizeApiKey(env?.[API_KEY_ENV])
}

type QueryValue = string | number | boolean | undefined | null

/** Build the request URL for a v1 operation from camelCase options. Unknown option names are ignored. */
export function operationUrl(
  baseUrl: string,
  id: OperationId,
  pathValues: Readonly<Record<string, string>>,
  options: object | undefined,
  format: Format | undefined,
): string {
  const op = operations[id]
  let path: string = op.path
  for (const name of op.pathParams) {
    const value = pathValues[name]
    if (!value?.trim()) throw new InputError(name === 'handle' ? 'invalid_handle' : 'invalid_params', `mdfromx: missing ${name}`)
    path = path.replace(`{${name}}`, encodeURIComponent(value))
  }
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`)
  const wires: Readonly<Record<string, string>> = op.query
  for (const [name, raw] of Object.entries((options ?? {}) as Record<string, QueryValue>)) {
    if (!Object.hasOwn(wires, name) || raw === undefined || raw === null) continue
    url.searchParams.set(wires[name], String(raw))
  }
  if (format) url.searchParams.set('format', format)
  return url.toString()
}

/** A post reference: an x.com / mdfromx status URL, a numeric id, or `{ handle, id }`. */
export type PostRef = string | { readonly url: string } | { readonly id: string, readonly handle?: string }

// The API pairs `id` with a handle; any handle resolves, and `i` is x.com's own handle-less form.
const ANY_HANDLE = 'i'

export function postRefParams(post: PostRef): { url?: string, id?: string, handle?: string } {
  if (typeof post === 'string') {
    const value = post.trim()
    if (!value) throw new InputError('missing_url', 'mdfromx: empty post reference')
    return /^\d+$/.test(value) ? { handle: ANY_HANDLE, id: value } : { url: value }
  }
  const value = 'url' in post ? post.url : post.id
  if (!value?.trim()) throw new InputError('missing_url', 'mdfromx: empty post reference')
  return 'url' in post ? { url: post.url } : { handle: post.handle || ANY_HANDLE, id: post.id }
}

/**
 * Seconds to wait before retrying, from the `Retry-After` header (seconds or an
 * HTTP date) or the problem body's `retry_after`.
 */
export function retryAfterSeconds(header: string | null | undefined, body?: number, now = Date.now()): number | undefined {
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds
    const date = Date.parse(header)
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000))
  }
  return typeof body === 'number' && body >= 0 ? body : undefined
}

export const RETRYABLE_STATUS = new Set([429, 503])

/** SDK-side code for an import stream that ended before its final meta line. */
export const STREAM_INCOMPLETE = 'stream_incomplete'
export const STREAM_INCOMPLETE_MESSAGE = 'The import stream ended before its final meta line, so the connection was cut. Retry the import.'

/**
 * How long to sleep before retry `attempt` (0-based), or undefined to stop.
 * The server's Retry-After wins; without one, back off 1s, 2s, 4s.
 */
export function retryDelayMs(status: number, retryAfter: number | undefined, attempt: number, retry: ResolvedRetry): number | undefined {
  if (!RETRYABLE_STATUS.has(status) || attempt >= retry.maxRetries) return undefined
  const delay = retryAfter !== undefined ? retryAfter * 1000 : 1000 * 2 ** attempt
  return delay <= retry.maxDelayMs ? delay : undefined
}
