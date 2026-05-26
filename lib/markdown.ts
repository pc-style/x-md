import type { FxArticle, FxAuthor, FxMedia, FxMediaItem, FxTweet } from './fxtwitter.js'
import type { OutputFormat } from './converter.js'

export type UserinfoLevel = 'off' | 'author' | 'all'

export interface RenderOptions {
  format: OutputFormat
  userinfo: UserinfoLevel
  canonicalUrl: string
}

function mediaItems(media?: FxMedia): FxMediaItem[] {
  if (!media) return []
  if (media.all?.length) return media.all
  return [...(media.photos ?? []), ...(media.videos ?? []), ...(media.animated ?? [])]
}

function renderMedia(media?: FxMedia): string[] {
  const lines: string[] = []
  for (const item of mediaItems(media)) {
    const type = (item.type ?? '').toLowerCase()
    const url = item.url ?? item.thumbnail_url
    const thumb = item.thumbnail_url ?? item.url
    if (!url && !thumb) continue

    if (type === 'photo' || type === 'image') {
      lines.push(`> ![image](${url})`)
    } else if (type === 'video') {
      lines.push(`> [video](${thumb ?? url})`)
    } else if (type === 'gif' || type === 'animated_gif') {
      lines.push(`> [animated_gif](${thumb ?? url})`)
    } else if (url) {
      lines.push(`> [media](${url})`)
    }
  }
  return lines
}

function articleToMarkdown(article: FxArticle): string[] {
  const lines: string[] = []
  if (article.title) {
    lines.push(`## ${article.title}`)
    lines.push('')
  }

  const cover = article.cover_media?.media_info?.original_img_url
  if (cover) {
    lines.push(`![cover](${cover})`)
    lines.push('')
  }

  const blocks = article.content?.blocks ?? []
  for (const block of blocks) {
    const text = block.text?.trim()
    if (!text) continue
    if (block.type === 'header-one') lines.push(`# ${text}`)
    else if (block.type === 'header-two') lines.push(`## ${text}`)
    else if (block.type === 'header-three') lines.push(`### ${text}`)
    else lines.push(text)
    lines.push('')
  }

  if (lines.length === 0 && article.preview_text) {
    lines.push(article.preview_text)
    lines.push('')
  }

  return lines
}

function authorInfoBlock(author: FxAuthor): string[] {
  const lines: string[] = ['### Author', '']
  if (author.name) lines.push(`- **Name:** ${author.name}`)
  if (author.screen_name) lines.push(`- **Handle:** @${author.screen_name}`)
  if (author.description) lines.push(`- **Bio:** ${author.description}`)
  if (author.location) lines.push(`- **Location:** ${author.location}`)
  if (author.website?.display_url || author.website?.url) {
    lines.push(`- **Website:** ${author.website.display_url ?? author.website.url}`)
  }
  if (author.followers != null) lines.push(`- **Followers:** ${author.followers.toLocaleString()}`)
  if (author.following != null) lines.push(`- **Following:** ${author.following.toLocaleString()}`)
  if (author.joined) lines.push(`- **Joined:** ${author.joined}`)
  lines.push('')
  return lines
}

function statsLine(tweet: FxTweet): string | undefined {
  const parts: string[] = []
  if (tweet.likes != null) parts.push(`${tweet.likes.toLocaleString()} likes`)
  if (tweet.retweets != null) parts.push(`${tweet.retweets.toLocaleString()} reposts`)
  if (tweet.replies != null) parts.push(`${tweet.replies.toLocaleString()} replies`)
  if (tweet.views != null) parts.push(`${tweet.views.toLocaleString()} views`)
  return parts.length ? parts.join(' · ') : undefined
}

function tweetUrl(tweet: FxTweet, fallback: string): string {
  if (tweet.url) return tweet.url
  const handle = tweet.author?.screen_name
  const id = tweet.id
  if (handle && id) return `https://x.com/${handle}/status/${id}`
  return fallback
}

function renderQuote(quote: FxTweet): string[] {
  const lines: string[] = ['> **Quoted post**', '>']
  const author = quote.author?.name ?? quote.author?.screen_name ?? 'Unknown'
  const handle = quote.author?.screen_name
  lines.push(`> **${author}**${handle ? ` @${handle}` : ''}`)
  if (quote.text) {
    for (const line of quote.text.split('\n')) {
      lines.push(`> ${line}`)
    }
  }
  for (const mediaLine of renderMedia(quote.media)) {
    lines.push(`> ${mediaLine.replace(/^> /, '')}`)
  }
  lines.push('>')
  return lines
}

function renderSingleTweet(
  tweet: FxTweet,
  opts: RenderOptions,
  index: number,
  total: number,
  includeAuthorMeta: boolean,
): string[] {
  const lines: string[] = []
  const author = tweet.author?.name ?? 'Unknown'
  const handle = tweet.author?.screen_name
  const source = tweetUrl(tweet, opts.canonicalUrl)
  const heading =
    total > 1 ? `## ${index + 1}/${total} — ${author}${handle ? ` (@${handle})` : ''}` : null

  if (opts.format === 'obsidian') {
    if (index === 0) {
      const tags = ['twitter', 'x']
      if (handle) tags.push(handle)
      lines.push('---')
      lines.push(`source: ${source}`)
      lines.push(`author: ${author}`)
      if (handle) lines.push(`author_handle: ${handle}`)
      if (tweet.created_at) lines.push(`published: ${tweet.created_at}`)
      if (total > 1) lines.push(`thread_posts: ${total}`)
      lines.push(`tags: [${tags.join(', ')}]`)
      lines.push('---')
      lines.push('')
    }
    if (heading) {
      lines.push(heading)
      lines.push('')
    }
  } else {
    if (heading) {
      lines.push(heading)
      lines.push('')
    } else {
      lines.push(`**${author}**`)
      if (handle) lines.push(`@${handle}`)
      lines.push('')
    }
    lines.push(`Source: ${source}`)
    if (tweet.created_at) lines.push(`Date: ${tweet.created_at}`)
    const stats = statsLine(tweet)
    if (stats) lines.push(`Stats: ${stats}`)
    lines.push('')
  }

  if (includeAuthorMeta && tweet.author) {
    lines.push(...authorInfoBlock(tweet.author))
  }

  if (tweet.article) {
    lines.push(...articleToMarkdown(tweet.article))
  }

  if (tweet.text?.trim()) {
    lines.push(tweet.text.trim())
    lines.push('')
  }

  lines.push(...renderMedia(tweet.media))

  if (tweet.quote) {
    lines.push(...renderQuote(tweet.quote))
    lines.push('')
  }

  return lines
}

export function renderThreadMarkdown(tweets: FxTweet[], opts: RenderOptions): string {
  const lines: string[] = []
  const seenAuthors = new Set<string>()

  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i]
    const handle = tweet.author?.screen_name ?? ''
    let includeAuthorMeta = false

    if (opts.userinfo === 'author' && i === 0 && tweet.author) {
      includeAuthorMeta = true
    } else if (opts.userinfo === 'all' && tweet.author && handle && !seenAuthors.has(handle)) {
      seenAuthors.add(handle)
      includeAuthorMeta = true
    }

    lines.push(...renderSingleTweet(tweet, opts, i, tweets.length, includeAuthorMeta))
    if (i < tweets.length - 1) lines.push('---', '')
  }

  return lines.join('\n').trim()
}
