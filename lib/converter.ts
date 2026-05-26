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

function parseThread(raw: string | null | undefined): { mode: 'off' | 'full'; limit: number } {
  if (!raw || raw === 'off') return { mode: 'off', limit: 1 }

  if (raw === 'full') return { mode: 'full', limit: 100 }

  const n = Number.parseInt(raw, 10)
  if (Number.isFinite(n) && n >= 2 && n <= 100) {
    return { mode: 'full', limit: n }
  }

  throw new ConvertError(
    400,
    '`thread` must be `off`, `full`, or a number from 2 to 100.',
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
    v: 1,
    id,
    format,
    thread: input.thread ?? 'off',
    userinfo: input.userinfo ?? 'off',
  })

  const { value, status } = await withCache(cacheKey, nocache, async () =>
    convertTweetUncached(format, thread, userinfo, canonicalUrl, handle, id),
  )

  return { ...value, cache: status }
}

export function markdownResponse(result: ConvertSuccess, asJson = false): {
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

  return {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      ...sharedHeaders,
    },
    body: result.body,
  }
}
