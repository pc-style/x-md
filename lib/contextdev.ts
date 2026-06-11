import { ConvertError } from './errors.js'
import type { FxTweet } from './fxtwitter.js'
import { extractStatusTextFromMarkdown } from './scrape-text.js'

const CONTEXT_DEV_MARKDOWN_API = 'https://api.context.dev/v1/web/scrape/markdown'
const UA = 'x-md/1.0'

interface ContextDevMarkdownResponse {
  success?: boolean
  markdown?: string
  url?: string
  error?: string
  message?: string
}

export async function fetchContextDevStatus(handle: string, id: string): Promise<FxTweet> {
  const apiKey = process.env.CONTEXT_DEV_API_KEY
  if (!apiKey) {
    throw new ConvertError(502, 'Context.dev fallback not configured.', 'contextdev_disabled')
  }

  const canonicalUrl = `https://x.com/${handle}/status/${id}`
  const url = new URL(CONTEXT_DEV_MARKDOWN_API)
  url.searchParams.set('url', canonicalUrl)
  url.searchParams.set('includeLinks', 'true')
  url.searchParams.set('includeImages', 'false')

  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'User-Agent': UA,
      },
    })
  } catch {
    throw new ConvertError(502, 'Failed to reach Context.dev API.', 'contextdev_network')
  }

  let payload: ContextDevMarkdownResponse
  try {
    payload = (await response.json()) as ContextDevMarkdownResponse
  } catch {
    throw new ConvertError(502, 'Context.dev returned an invalid response.', 'contextdev_invalid')
  }

  if (!response.ok || payload.success === false) {
    throw new ConvertError(
      502,
      payload.error ?? payload.message ?? `Context.dev returned ${response.status}.`,
      'contextdev_error',
    )
  }

  const markdown = payload.markdown?.trim()
  if (!markdown) {
    throw new ConvertError(502, 'Context.dev returned empty content.', 'contextdev_empty')
  }

  const text = extractStatusTextFromMarkdown(markdown) ?? markdown.slice(0, 2000)

  return {
    id,
    url: canonicalUrl,
    text,
    author: { name: handle, screen_name: handle, url: `https://x.com/${handle}` },
  }
}
