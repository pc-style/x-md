import { ConvertError } from './errors.js'
import { parseDateInput } from './fx-cursor.js'
import { importWithHistory, type HistoryInput, type HistoryResult } from './history.js'
import { IMPORT_DEFAULT_CONCURRENCY, IMPORT_DEFAULT_MAX_POSTS, IMPORT_MAX_CONCURRENCY_PER_BASE, IMPORT_MAX_POSTS } from './import.js'
import { chargeImportAllowance, describeAllowance, type ImportCharge, type QuotaCaller } from './ratelimit-headers.js'
import type { FxTweet } from './fxtwitter.js'

/**
 * One bulk-import request, whichever surface it arrived on: the HTTP routes
 * (api/import.ts) and the MCP import tool (lib/mcp.ts) parse, charge and run
 * through these, so they cannot disagree on validation, metering or limits.
 */

/** A walk past this is stopped and answered as a retryable partial failure. */
const IMPORT_TIME_BUDGET_MS = 110_000

export type ImportOptions = Omit<HistoryInput, 'signal' | 'onPost' | 'owner'>

export type ParsedImport =
  | { ok: true; options: ImportOptions }
  | { ok: false; code: 'invalid_handle' | 'invalid_option'; detail: string }

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

/** A whole positive number no larger than `max`; anything else is `NaN` so the caller can reject it. */
function bounded(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value === '') return undefined
  if (!/^\d{1,9}$/.test(value)) return Number.NaN
  const parsed = Number.parseInt(value, 10)
  return parsed >= 1 && parsed <= max ? parsed : Number.NaN
}

/**
 * Validate an import's parameters, given as the strings the HTTP query carries.
 * `maxPostsCap` lets a surface with a smaller response budget lower the cap.
 */
export function parseImportRequest(param: (key: string) => string | undefined, maxPostsCap = IMPORT_MAX_POSTS): ParsedImport {
  const invalid = (detail: string): ParsedImport => ({ ok: false, code: 'invalid_option', detail })
  const handle = (param('handle') ?? '').replace(/^@/, '')
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { ok: false, code: 'invalid_handle', detail: 'A valid X handle is required.' }
  for (const name of ['with_replies', 'with_reposts', 'only_replies', 'refresh', 'index']) {
    if (param(name) !== undefined && !['true', 'false', '1', '0'].includes(param(name)!)) return invalid(`\`${name}\` must be true, false, 1, or 0.`)
  }
  if (param('max_posts') && param('limit') && param('max_posts') !== param('limit')) return invalid('Use max_posts or its limit alias, not conflicting values.')
  if (flag(param('only_replies'), false) && param('with_replies') && !flag(param('with_replies'), true)) return invalid('only_replies=true conflicts with with_replies=false.')
  const since = parseDateInput(param('since'))
  const until = parseDateInput(param('until'))
  if (param('since') && !since) return invalid('`since` must be an ISO date, ISO datetime, or unix timestamp.')
  if (param('until') && !until) return invalid('`until` must be an ISO date, ISO datetime, or unix timestamp.')
  if (since && since.getTime() >= (until?.getTime() ?? Date.now())) return invalid('`since` must be earlier than `until`.')
  const maxPosts = bounded(param('max_posts') ?? param('limit'), maxPostsCap)
  const concurrency = bounded(param('concurrency'), IMPORT_MAX_CONCURRENCY_PER_BASE)
  if (Number.isNaN(maxPosts)) return invalid(`\`max_posts\` must be a whole number from 1 to ${maxPostsCap}.`)
  if (Number.isNaN(concurrency)) return invalid(`\`concurrency\` must be a whole number from 1 to ${IMPORT_MAX_CONCURRENCY_PER_BASE}.`)
  return {
    ok: true,
    options: {
      handle,
      since,
      until,
      maxPosts: maxPosts ?? Math.min(IMPORT_DEFAULT_MAX_POSTS, maxPostsCap),
      concurrency: concurrency ?? IMPORT_DEFAULT_CONCURRENCY,
      withReplies: flag(param('with_replies'), true),
      withReposts: flag(param('with_reposts'), true),
      onlyReplies: flag(param('only_replies'), false),
      refresh: flag(param('refresh'), false),
    },
  }
}

/**
 * Spend one import for `caller`. A refusal comes back as the `rate_limited`
 * error both surfaces report, naming the policy that refused it.
 */
export async function chargeImport(caller: QuotaCaller): Promise<{ charge: Extract<ImportCharge, { allowed: true }> } | { refused: ConvertError }> {
  const charge = await chargeImportAllowance(caller)
  if (charge.allowed) return { charge }
  const who = caller.key ? 'for this API key' : 'from this address'
  return { refused: new ConvertError(429, `Too many bulk imports ${who}: ${describeAllowance(charge.policy)}.`, 'rate_limited', charge.retryAfter, charge.policy.name) }
}

/**
 * Run a charged import to its end. A walk refused for want of an admission slot
 * (`import_busy`) gives its import back, and one that outlives the time budget
 * fails as a retryable partial failure.
 */
export async function runImport(
  options: ImportOptions,
  caller: QuotaCaller,
  charge: Extract<ImportCharge, { allowed: true }>,
  run: { signal?: AbortSignal; onPost?: (post: FxTweet) => void } = {},
): Promise<HistoryResult> {
  const timeout = AbortSignal.timeout(IMPORT_TIME_BUDGET_MS)
  const signal = run.signal ? AbortSignal.any([run.signal, timeout]) : timeout
  const owner = caller.key ? { kind: 'key' as const, id: caller.key.id } : { kind: 'ip' as const, id: caller.ip || 'unknown' }
  try {
    return await importWithHistory({ ...options, owner, signal, onPost: run.onPost })
  } catch (error) {
    if (error instanceof ConvertError && error.code === 'import_busy') await charge.refund()
    if (signal.aborted && (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError') throw new ConvertError(502, 'The import exceeded its time budget. Retry the same range.', 'partial_upstream_failure', 10)
    throw error
  }
}
