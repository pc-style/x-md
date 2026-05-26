import { ConvertError } from './errors.js'
import type { FxTweet } from './fxtwitter.js'

const FIRECRAWL_API = 'https://api.firecrawl.dev/v1/scrape'
const UA = 'x-md/1.0'

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

  const text = extractTweetText(markdown) ?? payload.data?.metadata?.description ?? markdown.slice(0, 2000)

  return {
    id,
    url: canonicalUrl,
    text,
    author: { name: handle, screen_name: handle, url: `https://x.com/${handle}` },
  }
}

function extractTweetText(markdown: string): string | undefined {
  const lines = markdown
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('![') && !l.startsWith('http'))

  const skip = new Set(['Post', 'Thread', 'Show this thread', 'Read more on X', 'X'])
  const body: string[] = []

  for (const line of lines) {
    if (line.startsWith('#')) continue
    if (skip.has(line)) continue
    if (line.match(/^@?\w+$/)) continue
    if (line.match(/^\d+(\.\d+)?[KMB]?\s*(replies|reposts|likes|views)/i)) continue
    body.push(line)
    if (body.join('\n').length > 500) break
  }

  const text = body.join('\n').trim()
  return text.length > 0 ? text : undefined
}
