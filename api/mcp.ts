import type { VercelRequest, VercelResponse } from '@vercel/node'
import { trackRequest } from '../lib/analytics.js'
import { callerHeaders, resolveCaller } from '../lib/apiauth.js'
import { parseJsonBody } from '../lib/http.js'
import { mediaQuality } from '../lib/negotiate.js'
import { applyQuotaPolicyOnly } from '../lib/ratelimit-headers.js'
import { clientIp } from '../lib/ratelimit.js'
import {
  dispatch,
  serverCard,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  MCP_DOCS_URL,
  MCP_ENDPOINT,
  MCP_HEADER_MISMATCH,
  MCP_LATEST_LEGACY_PROTOCOL,
  MCP_SUPPORTED_PROTOCOLS,
  MCP_UNSUPPORTED_PROTOCOL_VERSION,
  finalizeResult,
  isModernProtocol,
  requestedProtocol,
  type JsonRpcMessage,
} from '../lib/mcp.js'

/** Transport-level rejections still answer in JSON, so a plain HTTP client never has to parse an error page. */
function transportError(res: VercelResponse, status: number, code: number, message: string, data?: unknown) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  return res.status(status).send(JSON.stringify({ jsonrpc: '2.0', id: null, error: data === undefined ? { code, message } : { code, message, data } }))
}

/**
 * Streamable HTTP MCP server. Stateless by design: Vercel has no sticky
 * sessions, so the server mints no `Mcp-Session-Id` and ignores any it is sent,
 * which is what the 2026-07-28 revision tells session-less servers to do.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const identity = trackRequest(req, res, 'mcp')

  // The vercel.json CORS block keys off the incoming path, which is /mcp, not
  // /api/*, so this route sets its own.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type, Last-Event-ID, MCP-Protocol-Version, Mcp-Session-Id')
  res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, Mcp-Session-Id, Retry-After, X-Api-Key-Status, RateLimit, RateLimit-Policy, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Deprecation, Sunset, Link')
  res.setHeader('Access-Control-Max-Age', '86400')

  // The tools spend the same read allowance the REST routes charge, so the
  // transport advertises it even though dispatch charges it further down.
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
    const card = JSON.stringify(serverCard(), null, 2)
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
      return transportError(res, 405, JSONRPC_INVALID_REQUEST, `This MCP endpoint offers no standalone SSE stream. POST JSON-RPC messages to ${MCP_ENDPOINT} instead.`)
    }
    // Anything else — a scanner, curl, a browser — gets a manifest rather than
    // an error, so the endpoint is legible without speaking JSON-RPC first.
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=300')
    const manifest = JSON.stringify({
      ...serverCard(),
      protocolVersions: MCP_SUPPORTED_PROTOCOLS,
      documentation: MCP_DOCS_URL,
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

  const requested = req.headers['mcp-protocol-version']
  const headerProtocol = Array.isArray(requested) ? requested[0] : requested
  if (headerProtocol && !MCP_SUPPORTED_PROTOCOLS.includes(headerProtocol)) {
    return transportError(res, 400, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: MCP_SUPPORTED_PROTOCOLS,
      requested: headerProtocol,
    })
  }

  const parsed = parseJsonBody(req.body)
  if (!parsed.ok) return transportError(res, 400, JSONRPC_PARSE_ERROR, 'Parse error: Invalid JSON')
  if (Array.isArray(parsed.value)) {
    return transportError(res, 400, JSONRPC_INVALID_REQUEST, 'Invalid Request: JSON-RPC batching was removed in protocol revision 2025-06-18. Send one message per request.')
  }
  const message = (typeof parsed.value === 'object' && parsed.value !== null ? parsed.value : {}) as JsonRpcMessage
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
    return transportError(res, 400, JSONRPC_INVALID_REQUEST, 'Invalid Request: expected a JSON-RPC 2.0 object with a string `method`.')
  }

  // 2026-07-28 carries the version in `_meta` as well as the header, and requires
  // the two to agree: a proxy routing on the header while the server executes the
  // body is exactly the split-brain the HeaderMismatch code exists to stop.
  const bodyProtocol = requestedProtocol(message.params)
  if (bodyProtocol && !MCP_SUPPORTED_PROTOCOLS.includes(bodyProtocol)) {
    return transportError(res, 400, MCP_UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
      supported: MCP_SUPPORTED_PROTOCOLS,
      requested: bodyProtocol,
    })
  }
  if (bodyProtocol && headerProtocol && bodyProtocol !== headerProtocol) {
    return transportError(res, 400, MCP_HEADER_MISMATCH, 'The MCP-Protocol-Version header does not match the protocol version in the request body.', {
      header: headerProtocol,
      body: bodyProtocol,
    })
  }

  // A modern request announces itself; anything else is the legacy handshake era.
  const protocol = bodyProtocol ?? headerProtocol ?? MCP_LATEST_LEGACY_PROTOCOL
  const modern = isModernProtocol(protocol)
  res.setHeader('MCP-Protocol-Version', protocol)

  const resolved = await resolveCaller(req.headers)
  if (resolved.status === 'valid' && resolved.caller.kind === 'key') identity.keyId = resolved.caller.id
  for (const [key, value] of Object.entries(callerHeaders(resolved))) res.setHeader(key, value)
  if (resolved.status === 'invalid') {
    return transportError(res, 401, JSONRPC_INVALID_REQUEST, 'Invalid or disabled API key. Drop the Authorization header to call anonymously.')
  }

  let outcome
  try {
    outcome = finalizeResult(await dispatch(message, { ip: resolved.ip, caller: resolved.caller }), message.method, modern)
  } catch (error) {
    console.error(error)
    outcome = { error: { code: JSONRPC_INTERNAL_ERROR, message: 'Internal error' } }
  }

  // The modern transport answers an unimplemented RPC with 404, so a client can
  // tell it apart from a legacy endpoint that never hosted this path at all.
  if (modern && outcome && 'error' in outcome && outcome.error.code === JSONRPC_METHOD_NOT_FOUND) {
    return transportError(res, 404, JSONRPC_METHOD_NOT_FOUND, outcome.error.message, outcome.error.data)
  }

  // Never let one caller's MCP response reach another through the CDN.
  res.setHeader('Cache-Control', 'no-store')
  if (outcome === null) return res.status(202).end()

  const id = message.id ?? null
  const envelope = 'error' in outcome ? { jsonrpc: '2.0', id, error: outcome.error } : { jsonrpc: '2.0', id, result: outcome.result }
  if (wantsStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.status(200)
    res.write(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`)
    return res.end()
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  return res.status(200).send(JSON.stringify(envelope))
}
