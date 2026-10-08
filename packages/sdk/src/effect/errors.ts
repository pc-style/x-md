import type { Problem } from '../generated/types.js'
import { errorClasses, UnknownApiError, type ApiError } from './generated/errors.js'

/** What every API error carries, whatever its tag. */
export interface ApiErrorFields {
  readonly status: number
  readonly code: string
  readonly message: string
  /** The RFC 9457 problem body, when the API sent one. */
  readonly problem?: Problem
  /** Seconds the API asked to wait before retrying. */
  readonly retryAfter?: number
}

type ApiErrorClass = new (fields: ApiErrorFields) => ApiError

/** The tagged error for a problem `code`; unlisted codes become `UnknownApiError`. */
export function apiError(fields: ApiErrorFields): ApiError {
  const Class: ApiErrorClass = Object.hasOwn(errorClasses, fields.code)
    ? (errorClasses as Record<string, ApiErrorClass>)[fields.code]
    : UnknownApiError
  return new Class(fields)
}
