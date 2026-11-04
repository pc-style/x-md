import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { withErrorTracking } from '../lib/error-tracking.js'
import { callerHeaders, keyRequirementFailure, resolveCaller } from '../lib/apiauth.js'
import { parseJsonBody, requestOrigin } from '../lib/http.js'
import { mediaQuality } from '../lib/negotiate.js'
import { API_IP, apiIpKey } from '../lib/quotas.js'
import { applyExhaustedQuota, applyQuotaPolicyOnly, applyRequestQuota, chargeRequestQuota, type QuotaCaller } from '../lib/ratelimit-headers.js'
import { clientIp, refundRateLimit } from '../lib/ratelimit.js'
import {
  dispatch,
  serverCard,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_METHOD_NOT_FOUND,
  validateModernHeaders,
  validateModernMeta,
  JSONRPC_PARSE_ERROR,
  MCP_HEADER_MISMATCH,
  MCP_RATE_LIMITED,
  MCP_LATEST_LEGACY_PROTOCOL,
  MCP_SUPPORTED_PROTOCOLS,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  finalizeResult,
  isModernProtocol,
  requestedProtocol,
  type JsonRpcMessage,
} from '../lib/mcp.js'

/**
 * Transport-level rejections still answer in JSON, so a plain HTTP client never
 * has to parse an error page. `id` is the request's, once it has been read.
 */
function transportError(res: VercelResponse, status: number, code: number, message: string, data?: unknown, id: string | number | null = null) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  // A keyed answer already carries `private, no-store` from callerHeaders.
  if (!String(res.getHeader('Cache-Control') ?? '').includes('private')) res.setHeader('Cache-Control', 'no-store')
  return res.status(status).send(JSON.stringify({ jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } }))
}

/**
 * A serialized origin (RFC 6454 section 6.2): `null`, or `scheme://host[:port]`
 * with nothing after it. Any such origin may call this public endpoint, as the
 * `*` CORS policy says; only a value that is not an origin at all is refused.
 */
function isOrigin(value: string): boolean {
  if (value === 'null') return true
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/\\?#@\s]+$/i.test(value)) return false
  try {
    // Belt and braces: whatever URL parsing does with the authority, an origin has no path.
    const { pathname } = new URL(value)
    return pathname === '' || pathname === '/'
  } catch {
    return false
  }
}

/**
 * Streamable HTTP MCP server. Stateless by design: Vercel has no sticky
 * sessions, so the server mints no `Mcp-Session-Id` and ignores any it is sent,
 * which is what the 2026-07-28 revision tells session-less servers to do.
 */
async function handler(req: VercelRequest, res: VercelResponse) {
  const identity = trackRequest(req, res, 'mcp')
  // Self-links name the domain the client connected to, so a card fetched on
  // mdfromx.com does not send the client back to mdfromx.com.
  const site = requestOrigin(req)

  // The vercel.json CORS block keys off the incoming path, which is /mcp, not
  // /api/*, so this route sets its own.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id')
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id, Retry-After, X-Api-Key-Status, RateLimit, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Deprecation, Sunset, Link')
  res.setHeader('Access-Control-Max-Age', '86400')

  // Streamable HTTP: a present but invalid Origin is answered with 403.
  const origin = req.headers.origin
  if (origin !== undefined && !isOrigin(origin)) {
    return transportError(res, 403, JSONRPC_INVALID_REQUEST, 'Forbidden: the Origin header is not a valid origin.')
  }

  // Every tools/call spends the same read allowance the REST routes charge; it
  // is charged below, once the caller is resolved. Anything answered before
  // that, or any other method, advertises the policy alone.
  applyQuotaPolicyOnly(res, 'read', { ip: clientIp(req.headers) })

  const accept = String(req.headers.accept ?? '')
  // Only a client that names text/event-stream itself, at a q above 0, opts
  // into SSE: `;q=0` means the opposite, and a wildcard from a browser or curl
  // is not a request for a stream it cannot read.
  const stream = mediaQuality(accept, 'text/event-stream')
  const wantsStream = stream !== null && stream.exact && stream.q > 0

  if (req.query.doc === 'server-card') {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      res.setHeader('Allow', 'GET, HEAD, OPTIONS')
      return transportError(res, 405, JSONRPC_INVALID_REQUEST, 'The server card is read-only.')
    }
    if (req.method === 'OPTIONS') return res.status(204).end()
    res.setHeader('Content-Type', 'application/mcp-server-card+json; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    const card = JSON.stringify(serverCard(site), null, 2)
    return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(card)
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS, POST, DELETE')
    return res.status(204).end()
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (wantsStream) {
      // A conforming client opening the optional standalone SSE stream. This
      // server has no server-initiated messages to deliver, and both the
      // 2025-06-18 and 2026-07-28 revisions allow answering that GET with 405.
      res.setHeader('Allow', 'POST, OPTIONS')
      return transportError(res, 405, JSONRPC_INVALID_REQUEST, `This MCP endpoint offers no standalone SSE stream. POST JSON-RPC messages to ${site}/mcp instead.`)
    }
    // Anything else — a scanner, curl, a browser — gets a manifest rather than
    // an error, so the endpoint is legible without speaking JSON-RPC first.
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=300')
    // Vercel's CDN ignores `Vary: Accept` here: a stored manifest was replayed as
    // a 200 to clients asking for the SSE stream, which must get the 405 above.
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
    const manifest = JSON.stringify({
      ...serverCard(site),
      protocolVersions: MCP_SUPPORTED_PROTOCOLS,
      documentation: `${site}/docs/mcp`,
      usage: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        example: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      },
    }, null, 2)
    return req.method === 'HEAD' ? res.status(200).end() : res.status(200).send(manifest)
  }

  if (req.method === 'DELETE') {
    res.setHeader('Allow', 'POST, OPTIONS')
    return transportError(res, 405, JSONRPC_INVALID_REQUEST, 'This MCP server is stateless and issues no session id, so there is no session to terminate.')
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS, POST, DELETE')
    return transportError(res, 405, JSONRPC_INVALID_REQUEST, `Method ${req.method ?? 'unknown'} is not allowed on the MCP endpoint.`)
  }

  const parsed = parseJsonBody(req.body)
  if (!parsed.ok) return transportError(res, 400, JSONRPC_PARSE_ERROR, 'Parse error: Invalid JSON')
  if (Array.isArray(parsed.value)) {
    // Every revision offered here is 2025-06-18 or later, which removed batching.
    return transportError(res, 400, JSONRPC_INVALID_REQUEST, 'Invalid Request: JSON-RPC batching was removed in protocol revision 2025-06-18. Send one message per request.')
  }
  const message = (typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {}) as JsonRpcMessage
  // A request id is a string or a number, never null; a message with no id is a notification.
  const validId = message.id === undefined || typeof message.id === 'string' || typeof message.id === 'number'
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method || !validId) {
    return transportError(res, 400, JSONRPC_INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 object with a string `method` and, on a request, a string or number `id`.')
  }
  const id = message.id ?? null

  const requested = req.headers['mcp-protocol-version']
  const headerProtocol = Array.isArray(requested) ? requested[0] : requested
  if (headerProtocol && !MCP_SUPPORTED_PROTOCOLS.includes(headerProtocol)) {
    return transportError(res, 400, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: MCP_SUPPORTED_PROTOCOLS,
      requested: headerProtocol,
    }, id)
  }

  // 2026-07-28 carries the version in `_meta` as well as the header, and requires
  // the two to agree: a proxy routing on the header while the server executes the
  // body is exactly the split-brain the HeaderMismatch code exists to stop.
  const bodyProtocol = requestedProtocol(message.params)
  if (bodyProtocol && !MCP_SUPPORTED_PROTOCOLS.includes(bodyProtocol)) {
    return transportError(res, 400, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: MCP_SUPPORTED_PROTOCOLS,
      requested: bodyProtocol,
    }, id)
  }
  if (bodyProtocol && headerProtocol && bodyProtocol !== headerProtocol) {
    return transportError(res, 400, MCP_HEADER_MISMATCH, 'The MCP-Protocol-Version header does not match the protocol version in the request body.', {
      header: headerProtocol,
      body: bodyProtocol,
    }, id)
  }

  // A modern request announces itself; anything else is the legacy handshake era.
  const protocol = bodyProtocol ?? headerProtocol ?? MCP_LATEST_LEGACY_PROTOCOL
  const modern = isModernProtocol(protocol)
  res.setHeader('MCP-Protocol-Version', protocol)

  if (modern) {
    const header = (name: string): string | undefined => {
      const value = req.headers[name]
      return Array.isArray(value) ? value[0] : value
    }
    const invalid = validateModernHeaders(
      { protocolVersion: headerProtocol, method: header('mcp-method'), name: header('mcp-name') },
      message,
    )
    if (invalid) return transportError(res, 400, invalid.code, invalid.message, invalid.data, id)
    const malformed = validateModernMeta(message)
    if (malformed) return transportError(res, 400, malformed.code, malformed.message, malformed.data, id)
  }

  const resolved = await resolveCaller(req.headers)
  if (resolved.status === 'valid' && resolved.caller.kind === 'key') identity.keyId = resolved.caller.id
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  // Never let one caller's MCP response reach another through the CDN, and keep
  // the `private` callerHeaders promised a keyed caller.
  const cacheControl = resolved.status === 'valid' ? 'private, no-store' : 'no-store'
  if (resolved.status === 'invalid') {
    return transportError(res, 401, JSONRPC_INVALID_REQUEST, 'Invalid or disabled API key. Drop the Authorization header to call anonymously.', undefined, id)
  }
  const keyFailure = keyRequirementFailure(resolved)
  if (keyFailure) return transportError(res, 401, JSONRPC_INVALID_REQUEST, keyFailure, undefined, id)

  // A tool call is charged like a REST read. The charge and the tool's cache
  // lookup run together, and the tool waits for this verdict before it reaches
  // an upstream; a denial is answered here, never from inside the tool.
  const quotaCaller: QuotaCaller =
    resolved.caller.kind === 'key'
      ? { ip: resolved.ip, key: { id: resolved.caller.id, limit: resolved.caller.limit } }
      : { ip: resolved.ip }
  const charged = message.method === 'tools/call' && message.id !== undefined ? chargeRequestQuota('read', quotaCaller) : undefined
  const admission = charged?.then((quota) => quota.allowed)
  admission?.catch(() => undefined)
  // Documents are fetched from a trusted origin, never from the Host header:
  // the Vite adapter lends its own listening origin; on Vercel it is unset.
  const documentOrigin = (req as { documentOrigin?: string }).documentOrigin
  const pending = dispatch(message, { ip: resolved.ip, caller: resolved.caller, era: modern ? 'modern' : 'legacy', site, documentOrigin, admission })
  pending.catch(() => undefined)
  const quota = await charged
  if (quota) applyRequestQuota(res, quota)

  let outcome
  try {
    outcome = finalizeResult(await pending, message.method, modern)
  } catch (error) {
    console.error(error)
    outcome = { error: { code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' } }
  }

  // A tool answered from the application cache reached no upstream, so it is
  // served even on a spent allowance and gives its charge back. Only a call
  // that needed an upstream is refused, and it keeps its charge.
  const hit = outcome !== null && 'result' in outcome && (outcome.result as { structuredContent?: { cache?: unknown } }).structuredContent?.cache === 'hit'
  if (quota && hit && quota.bucket !== undefined) {
    await refundRateLimit(apiIpKey(resolved.ip), API_IP.windowSec, quota.bucket)
    if (quota.allowed) applyRequestQuota(res, { ...quota, states: quota.states.map((state) => (state.name === API_IP.name ? { ...state, remaining: Math.min(state.quota, state.remaining + 1) } : state)) })
  }
  if (quota && !quota.allowed && !hit) {
    applyExhaustedQuota(res, quota, API_IP.name, quota.retryAfter)
    res.setHeader('Cache-Control', cacheControl)
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    const retryAfter = Math.max(1, quota.retryAfter)
    const error = {
      code: MCP_RATE_LIMITED,
      message: 'Too many requests from this address. Profile, follower, following and search results already cached are still served.',
      data: { status: 429, code: 'rate_limited', policy: API_IP.name, retryAfter },
    }
    return res.status(429).send(JSON.stringify({ jsonrpc: '2.0', id, error }))
  }

  // The modern transport answers an unimplemented RPC with 404, so a client can
  // tell it apart from a legacy endpoint that never hosted this path at all.
  if (modern && outcome && 'error' in outcome && outcome.error.code === JSONRPC_METHOD_NOT_FOUND) {
    return transportError(res, 404, JSONRPC_METHOD_NOT_FOUND, outcome.error.message, outcome.error.data, id)
  }

  res.setHeader('Cache-Control', cacheControl)
  if (outcome === null) return res.status(202).end()

  const envelope = 'error' in outcome ? { jsonrpc: '2.0', id, error: outcome.error } : { jsonrpc: '2.0', id, result: outcome.result }
  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', `${cacheControl}, no-transform`)
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.status(200)
    res.write(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`)
    return res.end()
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.status(200).send(JSON.stringify(envelope))
}

export default withErrorTracking(handler)
