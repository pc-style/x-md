import type { ErrorCode, Problem } from './generated/types.js'

/**
 * A non-2xx answer from the API, carrying its RFC 9457 problem details.
 *
 * Branch on `code`: every documented code is in `ErrorCode`. A 502 or 503 may
 * carry an unlisted provider code, so `code` also accepts other strings.
 */
export class MdfromxError extends Error {
  override readonly name = 'MdfromxError'
  readonly status: number
  readonly code: ErrorCode | (string & {})
  /** The problem body, when the API sent one. */
  readonly problem: Problem | undefined
  /** Seconds the API asked to wait before retrying, from `Retry-After` or the body. */
  readonly retryAfter: number | undefined
  readonly headers: Headers

  constructor(init: {
    status: number
    code: string
    message: string
    problem?: Problem
    retryAfter?: number
    headers?: Headers
  }) {
    super(init.message)
    this.status = init.status
    this.code = init.code
    this.problem = init.problem
    this.retryAfter = init.retryAfter
    this.headers = init.headers ?? new Headers()
  }
}

export const isMdfromxError = (error: unknown): error is MdfromxError => error instanceof MdfromxError

/** Read a problem body if the response has one; otherwise describe the status. */
export function problemFrom(status: number, body: string): { code: string, message: string, problem?: Problem } {
  try {
    const parsed = JSON.parse(body) as Partial<Problem>
    if (parsed && typeof parsed.code === 'string') {
      const problem = parsed as Problem
      return { code: problem.code, message: problem.detail || problem.title || `HTTP ${status}`, problem }
    }
  } catch {
    // Not JSON: a Markdown recovery page (404 to a Markdown request) or a proxy error page.
  }
  if (status === 404) return { code: 'not_found', message: 'Not found' }
  return { code: `http_${status}`, message:`HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}` }
}
