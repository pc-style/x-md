export class ConvertError extends Error {
  readonly status: number
  readonly code?: string
  /** Seconds until the client may retry; set on 429 responses. */
  readonly retryAfter?: number
  /**
   * Name of the `RateLimit` policy that rejected the request. The response layer
   * needs it to report that one policy as exhausted: the limits charge far below
   * the handler, so the error is the only thing that knows which one ran out.
   */
  readonly policy?: string

  constructor(status: number, message: string, code?: string, retryAfter?: number, policy?: string) {
    super(message)
    this.name = 'ConvertError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
    this.policy = policy
  }
}
