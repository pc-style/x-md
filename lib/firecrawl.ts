import { ConvertError } from './errors.js'
import type { FxTweet } from './fxtwitter.js'
import { extractStatusTextFromMarkdown } from './scrape-text.js'

const FIRECRAWL_API = 'https://api.firecrawl.dev/v1/scrape'
const FIRECRAWL_SEARCH_API = 'https://api.firecrawl.dev/v2/search'
const UA = 'x-md/1.0'

export function firecrawlSearchConfigured(): boolean {
  return Boolean(process.env.FIRECRAWL_API_KEY)
}

interface FirecrawlSearchHit {
  url?: string
  title?: string
  description?: string
  position?: number
}

interface FirecrawlSearchResponse {
  success?: boolean
  data?: { web?: FirecrawlSearchHit[] } | FirecrawlSearchHit[]
  error?: string
}

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/(status|article)\/(\d+)/

/** Pull a display name out of Firecrawl titles like `Name (@handle) on X` or `Name on X: "..."`. */
function nameFromTitle(title: string | undefined): string | undefined {
  const match = title?.match(/^(.*?)(?:\s*\(@[A-Za-z0-9_]+\))?\s+on X\b/)
  const name = match?.[1]?.trim()
  return name && name !== 'Post' ? name : undefined
}

/**
 * Map one web hit to an FxTweet. Only status/article URLs qualify; profile,
 * with_replies, highlights and other page types are dropped. Text is the search
 * snippet, not verified post text, and no metrics are invented.
 */
export function firecrawlHitToPost(hit: FirecrawlSearchHit): FxTweet | undefined {
  const match = hit.url?.match(STATUS_URL)
  if (!match) return undefined
  const [, handle, kind, id] = match
  const text = (hit.description ?? '')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^(?:\d+\s+\w+\s+ago|[A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)\s*[·—-]\s*/, '')
    .replace(/\s*(?:Log in or sign up|Read more on X|Sign up)\.?$/i, '')
    .trim()
  if (!text) return undefined
  const name = nameFromTitle(hit.title)
  // `x.com/i/status/:id` carries no handle; keep the display name and skip the profile link.
  const author = handle === 'i'
    ? { name: name ?? 'unknown' }
    : { name: name ?? handle, screen_name: handle, url: `https://x.com/${handle}` }
  return { id, url: `https://x.com/${handle}/${kind}/${id}`, text, author }
}

/**
 * Degraded keyword search over Firecrawl's web index restricted to x.com.
 * `latest` narrows to the past week; `top`/`media` use plain relevance.
 * Returns web-indexed snippets, not a live X timeline; no cursor is available.
 */
export async function searchFirecrawlStatuses(queryText: string, feed: string, limit: number): Promise<FxTweet[]> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    throw new ConvertError(503, 'Firecrawl search fallback not configured.', 'firecrawl_disabled')
  }

  let response: Response
  try {
    response = await fetch(FIRECRAWL_SEARCH_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({
        query: queryText,
        sources: ['web'],
        // Ask for extra hits: profile and list pages get filtered out below.
        limit: Math.min(Math.max(limit * 2, 10), 50),
        includeDomains: ['x.com'],
        ...(feed === 'latest' ? { tbs: 'qdr:w' } : {}),
        scrapeOptions: { formats: [] },
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ConvertError(503, 'Failed to reach Firecrawl search.', 'firecrawl_network')
  }

  let payload: FirecrawlSearchResponse
  try {
    payload = (await response.json()) as FirecrawlSearchResponse
  } catch {
    throw new ConvertError(503, 'Firecrawl search returned an invalid response.', 'firecrawl_invalid')
  }
  if (!response.ok || payload.success === false) {
    throw new ConvertError(503, payload.error ?? `Firecrawl search returned ${response.status}.`, 'firecrawl_error')
  }

  const hits = Array.isArray(payload.data) ? payload.data : payload.data?.web ?? []
  const seen = new Set<string>()
  const posts: FxTweet[] = []
  for (const hit of hits) {
    const post = firecrawlHitToPost(hit)
    if (!post?.id || seen.has(post.id)) continue
    seen.add(post.id)
    posts.push(post)
    if (posts.length >= limit) break
  }
  return posts
}

interface FirecrawlResponse {
  success?: boolean
  data?: { markdown?: string; metadata?: { description?: string } }
  error?: string
}

export async function fetchFirecrawlStatus(handle: string, id: string): Promise<FxTweet> {
  const apiKey = process.env.FIRECRAWL_API_KEY
  if (!apiKey) {
    throw new ConvertError(502, 'Firecrawl fallback not configured.', 'firecrawl_disabled')
  }

  const canonicalUrl = `https://x.com/${handle}/status/${id}`

  let response: Response
  try {
    response = await fetch(FIRECRAWL_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        url: canonicalUrl,
        formats: ['markdown'],
        onlyMainContent: true,
        waitFor: 2000,
      }),
    })
  } catch {
    throw new ConvertError(502, 'Failed to reach Firecrawl API.', 'firecrawl_network')
  }

  const payload = (await response.json()) as FirecrawlResponse

  if (!response.ok || !payload.success) {
    throw new ConvertError(
      502,
      payload.error ?? `Firecrawl returned ${response.status}.`,
      'firecrawl_error',
    )
  }

  const markdown = payload.data?.markdown?.trim()
  if (!markdown) {
    throw new ConvertError(502, 'Firecrawl returned empty content.', 'firecrawl_empty')
  }

  const text = extractStatusTextFromMarkdown(markdown) ?? payload.data?.metadata?.description ?? markdown.slice(0, 2000)

  return {
    id,
    url: canonicalUrl,
    text,
    author: { name: handle, screen_name: handle, url: `https://x.com/${handle}` },
  }
}
