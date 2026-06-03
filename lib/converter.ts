import { buildCacheKey, cacheControlHeader, type CacheStatus, withCache } from './cache.js'
import { ConvertError } from './errors.js'
import { fetchPosts, type FetchSource } from './tweet-fetch.js'
import { renderThreadMarkdown, type UserinfoLevel } from './markdown.js'

export type OutputFormat = 'markdown' | 'obsidian'

export { ConvertError }

export interface ConvertInput {
  url?: string | null
  handle?: string | null
  id?: string | null
  format?: string | null
  thread?: string | null
  userinfo?: string | null
  nocache?: boolean | string | null
}

export interface ConvertSuccess {
  body: string
  warnings: string[]
  canonicalUrl: string
  format: OutputFormat
  postCount: number
  source: FetchSource
  cache: CacheStatus
}

const ALLOWED_HOSTS = new Set([
  'x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'x.pcstyle.dev',
])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1'])
const STATUS_PATH = /^\/([^/?#]+)\/status\/(\d+)\/?$/

export function parseStatusUrl(raw: string): { handle: string; id: string; canonicalUrl: string } {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new ConvertError(400, 'Invalid URL. Provide a public X/Twitter status URL.', 'invalid_url')
  }

  const host = parsed.hostname.replace(/^www\./, '')
  const isAllowed =
    ALLOWED_HOSTS.has(host) ||
    LOCAL_HOSTS.has(host) ||
    host.endsWith('.vercel.app')

  if (!isAllowed) {
    throw new ConvertError(
      400,
      'Only x.com or twitter.com status URLs are supported.',
      'unsupported_host',
    )
  }

  const match = STATUS_PATH.exec(parsed.pathname)
  if (!match) {
    throw new ConvertError(
      400,
      'URL must be a status permalink like https://x.com/handle/status/1234567890.',
      'invalid_path',
    )
  }

  const handle = match[1]
  const id = match[2]
  return {
    handle,
    id,
    canonicalUrl: `https://x.com/${handle}/status/${id}`,
  }
}

export function resolveTarget(input: ConvertInput): { canonicalUrl: string; handle: string; id: string } {
  if (input.url) {
    return parseStatusUrl(input.url)
  }

  if (input.handle && input.id) {
    const handle = input.handle.replace(/^@/, '')
    const id = input.id.replace(/\D/g, '')
    if (!handle || !id) {
      throw new ConvertError(400, 'Missing or invalid handle/status id.', 'invalid_params')
    }
    return {
      handle,
      id,
      canonicalUrl: `https://x.com/${handle}/status/${id}`,
    }
  }

  throw new ConvertError(400, 'Missing required `url` query parameter.', 'missing_url')
}

function parseFormat(raw: string | null | undefined): OutputFormat {
  if (!raw || raw === 'markdown') return 'markdown'
  if (raw === 'obsidian') return 'obsidian'
  throw new ConvertError(400, '`format` must be `markdown` or `obsidian`.', 'invalid_format')
}

const DEFAULT_THREAD = 'full'

function canonicalThreadCacheValue(raw: string | null | undefined): string {
  if (raw === 'off') return 'off'
  if (!raw || raw === 'full' || raw === 'conversation') return DEFAULT_THREAD
  return raw
}

function parseThread(raw: string | null | undefined): { mode: 'off' | 'full'; limit: number } {
  if (raw === 'off') return { mode: 'off', limit: 1 }

  if (!raw || raw === 'full' || raw === 'conversation') return { mode: 'full', limit: 100 }

  const n = Number.parseInt(raw, 10)
  if (Number.isFinite(n) && n >= 2 && n <= 100) {
    return { mode: 'full', limit: n }
  }

  throw new ConvertError(
    400,
    '`thread` must be `off`, `full`, `conversation`, or a number from 2 to 100.',
    'invalid_thread',
  )
}

function parseUserinfo(raw: string | null | undefined): UserinfoLevel {
  if (!raw || raw === 'off') return 'off'
  if (raw === 'author') return 'author'
  if (raw === 'all') return 'all'
  throw new ConvertError(400, '`userinfo` must be `off`, `author`, or `all`.', 'invalid_userinfo')
}

function parseNocache(raw: string | boolean | null | undefined): boolean {
  if (raw === true) return true
  if (raw === false || raw == null) return false
  return raw === '1' || raw === 'true' || raw === 'yes'
}

type ConvertPayload = Omit<ConvertSuccess, 'cache'>

async function convertTweetUncached(
  format: OutputFormat,
  thread: { mode: 'off' | 'full'; limit: number },
  userinfo: UserinfoLevel,
  canonicalUrl: string,
  handle: string,
  id: string,
): Promise<ConvertPayload> {
  const warnings: string[] = []

  const { tweets, source } = await fetchPosts(handle, id, thread.mode)

  let posts = tweets
  if (thread.mode === 'full' && posts.length > thread.limit) {
    posts = posts.slice(0, thread.limit)
    warnings.push(`Thread truncated to ${thread.limit} posts.`)
  }

  if (source !== 'fxtwitter') {
    warnings.push(
      `Fetched via ${source} fallback — threads, full articles, and quotes may be limited.`,
    )
  }

  const body = renderThreadMarkdown(posts, {
    format,
    userinfo,
    canonicalUrl,
  })

  return {
    body,
    warnings,
    canonicalUrl,
    format,
    postCount: posts.length,
    source,
  }
}

export async function convertTweet(input: ConvertInput): Promise<ConvertSuccess> {
  const format = parseFormat(input.format)
  const thread = parseThread(input.thread)
  const userinfo = parseUserinfo(input.userinfo)
  const nocache = parseNocache(input.nocache)
  const { canonicalUrl, handle, id } = resolveTarget(input)

  const cacheKey = buildCacheKey({
    v: 2,
    id,
    format,
    thread: canonicalThreadCacheValue(input.thread),
    userinfo: input.userinfo ?? 'off',
  })

  const { value, status } = await withCache(cacheKey, nocache, async () =>
    convertTweetUncached(format, thread, userinfo, canonicalUrl, handle, id),
  )

  return { ...value, cache: status }
}

export function acceptPrefersHtml(accept: string): boolean {
  if (accept.includes('application/json') || accept.includes('text/markdown')) return false
  return accept.includes('text/html')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function htmlMarkdownPage(markdown: string, canonicalUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(canonicalUrl)} · x.md</title>
  <style>
    body { margin: 0; background: #08090a; color: #d0d6e0; font-family: "IBM Plex Mono", ui-monospace, monospace; }
    pre { margin: 0; padding: 1.5rem; white-space: pre-wrap; word-break: break-word; line-height: 1.65; font-size: 13px; }
  </style>
</head>
<body><pre>${escapeHtml(markdown)}</pre></body>
</html>`
}

export function markdownResponse(result: ConvertSuccess, asJson = false, asHtml = false): {
  status: number
  headers: Record<string, string>
  body: string
} {
  const sharedHeaders: Record<string, string> = {
    'X-Converter': 'x-md',
    'X-Source': result.source,
    'X-Post-Count': String(result.postCount),
    'X-Warnings': String(result.warnings.length),
    'X-Cache': result.cache.toUpperCase(),
  }

  if (result.cache !== 'bypass') {
    sharedHeaders['Cache-Control'] = cacheControlHeader()
  }

  if (asJson) {
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...sharedHeaders },
      body: JSON.stringify({
        format: result.format,
        url: result.canonicalUrl,
        markdown: result.body,
        warnings: result.warnings,
        postCount: result.postCount,
        source: result.source,
        cache: result.cache,
      }),
    }
  }

  if (asHtml) {
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...sharedHeaders },
      body: htmlMarkdownPage(result.body, result.canonicalUrl),
    }
  }

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      ...sharedHeaders,
    },
    body: result.body,
  }
}
