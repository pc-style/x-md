import type { ConvertSuccess } from './converter.js'
import type { FxMedia, FxMediaItem, FxPoll, FxTweet } from './fxtwitter.js'

export const SITE_NAME = 'x.md'
export const THEME_COLOR = '#146c43'

/** Social preview crawlers that should receive Open Graph HTML. */
export const EMBED_UA_REGEX =
  /discordbot|telegrambot|slackbot|slack-img|whatsapp|facebookexternalhit|facebot|linkedinbot|skypeuripreview|vkshare|pinterest|redditbot|embedly|iframely|steamchaturllookup|revoltchat|matrixpreviewbot/i

export const NATIVE_MULTI_IMAGE_UA_REGEX = /discordbot|matrixpreviewbot/i

export function isEmbedUserAgent(userAgent: string): boolean {
  return EMBED_UA_REGEX.test(userAgent)
}

export function supportsNativeMultiImage(userAgent: string): boolean {
  return NATIVE_MULTI_IMAGE_UA_REGEX.test(userAgent)
}

export interface EmbedOptions {
  origin: string
  userAgent?: string
}

export interface OEmbedQuery {
  url?: string | null
  text?: string | null
  author?: string | null
  status?: string | null
  provider?: string | null
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function formatCount(num: number): string {
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`
  if (num >= 995_000) return '1.00M'
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`
  return String(num)
}

export function socialProof(tweet: FxTweet): string | undefined {
  const parts: string[] = []
  if ((tweet.replies ?? 0) > 0) parts.push(`💬 ${formatCount(tweet.replies ?? 0)}`)
  if ((tweet.retweets ?? 0) > 0) parts.push(`🔁 ${formatCount(tweet.retweets ?? 0)}`)
  if ((tweet.likes ?? 0) > 0) parts.push(`❤️ ${formatCount(tweet.likes ?? 0)}`)
  if ((tweet.views ?? 0) > 0) parts.push(`👁️ ${formatCount(tweet.views ?? 0)}`)
  return parts.length ? parts.join('   ') : undefined
}

function quoteBlock(quote: FxTweet): string {
  const name = quote.author?.name ?? 'Unknown'
  const handle = quote.author?.screen_name
  const header = handle ? `Quoting ${name} (@${handle})` : `Quoting ${name}`
  const text = quote.text?.trim()
  return text ? `\n${header}\n\n${text}` : `\n${header}`
}

function pollBlock(poll: FxPoll, barLength = 32): string {
  const lines: string[] = ['']
  for (const choice of poll.choices ?? []) {
    const pct = choice.percentage ?? 0
    const bar = '█'.repeat(Math.round((pct / 100) * barLength))
    const label = choice.label ?? ''
    lines.push(bar, `${label}\u2000\u2000(${pct}%)`)
  }
  const votes = poll.total_votes
  const timeLeft = poll.time_left_en
  const footer = [
    votes != null ? `${votes} ${votes === 1 ? 'vote' : 'votes'}` : undefined,
    timeLeft,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
  if (footer) lines.push('', footer)
  return `\n${lines.join('\n')}`
}

export function embedDescription(tweet: FxTweet): string {
  let text = tweet.text ?? ''
  if (tweet.poll && Array.isArray(tweet.poll.choices)) {
    text += pollBlock(tweet.poll)
  }
  if (tweet.quote) {
    text += quoteBlock(tweet.quote)
  }
  return text
}

export function pickFocalTweet(posts: FxTweet[], requestedId?: string): FxTweet | undefined {
  if (requestedId) {
    const match = posts.find((post) => post.id === requestedId)
    if (match) return match
  }
  return posts.find((post) => post.context === 'post') ?? posts[0]
}

function isPlayableMp4(url: string, contentType?: string): boolean {
  if (contentType === 'video/mp4') return true
  return /\.mp4(?:$|[?#])/i.test(url)
}

function bestVideoUrl(item: FxMediaItem): string | undefined {
  const mp4s = item.variants
    ?.filter((variant) => variant.url && isPlayableMp4(variant.url, variant.content_type))
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))
  if (mp4s?.[0]?.url) return mp4s[0].url
  if (item.url && isPlayableMp4(item.url, item.format)) return item.url
  return undefined
}

function videoDimensions(item: FxMediaItem): { width: number; height: number } {
  let width = item.width ?? 1280
  let height = item.height ?? 720
  if (width > 1920 || height > 1920) {
    width = Math.round(width / 2)
    height = Math.round(height / 2)
  } else if (width < 400 && height < 400) {
    width *= 2
    height *= 2
  }
  return { width, height }
}

function firstVideo(media?: FxMedia): FxMediaItem | undefined {
  return media?.videos?.[0] ?? media?.animated?.[0]
}

function mosaicUrl(media?: FxMedia): string | undefined {
  return media?.mosaic?.formats?.jpeg ?? media?.mosaic?.formats?.webp
}

function photoTags(photo: FxMediaItem): string[] {
  if (!photo.url) return []
  const tags = [
    `<meta property="twitter:image" content="${escapeAttr(photo.url)}">`,
    `<meta property="og:image" content="${escapeAttr(photo.url)}">`,
  ]
  if (photo.width != null && photo.height != null) {
    const w = String(photo.width)
    const h = String(photo.height)
    tags.push(
      `<meta property="twitter:image:width" content="${w}">`,
      `<meta property="twitter:image:height" content="${h}">`,
      `<meta property="og:image:width" content="${w}">`,
      `<meta property="og:image:height" content="${h}">`,
    )
  }
  const alt = photo.alt ?? photo.altText
  if (alt) {
    tags.push(
      `<meta property="twitter:image:alt" content="${escapeAttr(alt)}">`,
      `<meta property="og:image:alt" content="${escapeAttr(alt)}">`,
    )
  }
  return tags
}

function videoTags(video: FxMediaItem): string[] {
  const url = bestVideoUrl(video)
  if (!url) return []
  const { width, height } = videoDimensions(video)
  const mime = video.format?.includes('/') ? video.format : 'video/mp4'
  const thumb = video.thumbnail_url
  const tags = [
    `<meta property="twitter:player:width" content="${width}">`,
    `<meta property="twitter:player:height" content="${height}">`,
    `<meta property="twitter:player:stream" content="${escapeAttr(url)}">`,
    `<meta property="twitter:player:stream:content_type" content="${escapeAttr(mime)}">`,
    `<meta property="og:video" content="${escapeAttr(url)}">`,
    `<meta property="og:video:secure_url" content="${escapeAttr(url)}">`,
    `<meta property="og:video:type" content="${escapeAttr(mime)}">`,
    `<meta property="og:video:width" content="${width}">`,
    `<meta property="og:video:height" content="${height}">`,
  ]
  if (thumb) {
    tags.push(`<meta property="og:image" content="${escapeAttr(thumb)}">`)
    tags.push('<meta property="twitter:image" content="0">')
  }
  return tags
}

interface MediaPlan {
  card: 'summary' | 'summary_large_image' | 'player'
  tags: string[]
}

function stillImagePlan(item: FxMediaItem | undefined): MediaPlan | undefined {
  const url = item?.thumbnail_url ?? item?.url
  if (!url || /\.m3u8(?:$|[?#])/i.test(url)) return undefined
  return {
    card: 'summary_large_image',
    tags: [
      `<meta property="twitter:image" content="${escapeAttr(url)}">`,
      `<meta property="og:image" content="${escapeAttr(url)}">`,
    ],
  }
}

function mediaPlan(tweet: FxTweet, multiImage: boolean, staticVideoFallback: boolean): MediaPlan {
  const own = tweet.media
  const quoted = tweet.quote?.media
  const video = firstVideo(own) ?? firstVideo(quoted)
  if (video) {
    if (staticVideoFallback && video.thumbnail_url) {
      const still = stillImagePlan(video)
      if (still) return still
    }
    if (bestVideoUrl(video)) return { card: 'player', tags: videoTags(video) }
    const still = stillImagePlan(video)
    if (still) return still
  }

  const photos = own?.photos?.filter((photo) => photo.url) ?? []
  const quotedPhotos = quoted?.photos?.filter((photo) => photo.url) ?? []
  const ownMosaic = mosaicUrl(own)
  const quotedMosaic = mosaicUrl(quoted)

  if (photos.length > 1 && multiImage) {
    return { card: 'summary_large_image', tags: photos.flatMap(photoTags) }
  }
  if (ownMosaic && photos.length > 1) {
    return {
      card: 'summary_large_image',
      tags: [
        `<meta property="twitter:image" content="${escapeAttr(ownMosaic)}">`,
        `<meta property="og:image" content="${escapeAttr(ownMosaic)}">`,
      ],
    }
  }
  if (photos[0]) {
    return { card: 'summary_large_image', tags: photoTags(photos[0]) }
  }
  if (quotedPhotos.length > 1 && multiImage) {
    return { card: 'summary_large_image', tags: quotedPhotos.flatMap(photoTags) }
  }
  if (quotedMosaic && quotedPhotos.length > 1) {
    return {
      card: 'summary_large_image',
      tags: [
        `<meta property="twitter:image" content="${escapeAttr(quotedMosaic)}">`,
        `<meta property="og:image" content="${escapeAttr(quotedMosaic)}">`,
      ],
    }
  }
  if (quotedPhotos[0]) {
    return { card: 'summary_large_image', tags: photoTags(quotedPhotos[0]) }
  }

  const avatar = tweet.author?.avatar_url
  if (avatar) {
    return {
      card: 'summary',
      tags: [
        `<meta property="og:image" content="${escapeAttr(avatar)}">`,
        '<meta property="twitter:image" content="0">',
        `<link rel="apple-touch-icon" href="${escapeAttr(avatar)}">`,
      ],
    }
  }
  return { card: 'summary', tags: [] }
}

export function buildEmbedHtml(tweet: FxTweet, options: EmbedOptions): string {
  const handle = tweet.author?.screen_name ?? 'i'
  const name = tweet.author?.name ?? handle
  const id = tweet.id ?? '0'
  const canonical = tweet.url ?? `https://x.com/${handle}/status/${id}`
  const title = `${name} (@${handle})`
  const description = embedDescription(tweet)
  const proof = socialProof(tweet) ?? 'Embed'
  const userAgent = options.userAgent ?? ''
  const multiImage = supportsNativeMultiImage(userAgent)
  const media = mediaPlan(tweet, multiImage, /slackbot|slack-img/i.test(userAgent))
  const oembed = new URL('/oembed', options.origin)
  oembed.searchParams.set('url', canonical)
  oembed.searchParams.set('text', proof.slice(0, 255))
  oembed.searchParams.set('status', id)
  oembed.searchParams.set('author', handle)
  if (media.card === 'player' && proof !== 'Embed') {
    oembed.searchParams.set('provider', proof)
  }

  const tags = [
    `<link rel="canonical" href="${escapeAttr(canonical)}">`,
    `<meta property="og:url" content="${escapeAttr(canonical)}">`,
    `<meta property="og:title" content="${escapeAttr(title)}">`,
    `<meta property="og:description" content="${escapeAttr(description)}">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta name="theme-color" content="${THEME_COLOR}">`,
    `<meta property="twitter:card" content="${media.card}">`,
    `<meta property="twitter:title" content="${escapeAttr(title)}">`,
    `<meta property="twitter:site" content="@${escapeAttr(handle)}">`,
    `<meta property="twitter:creator" content="@${escapeAttr(handle)}">`,
    ...media.tags,
    `<link rel="alternate" type="application/json+oembed" href="${escapeAttr(oembed.toString())}" title="${escapeAttr(name)}">`,
  ]

  return `<!doctype html>
<html lang="${escapeAttr(tweet.lang ?? 'en')}">
<head>
${tags.join('\n')}
</head>
<body></body>
</html>`
}

export function embedResponse(
  result: ConvertSuccess,
  options: EmbedOptions,
): { status: number; headers: Record<string, string>; body: string } {
  const requestedId = result.canonicalUrl.match(/\/status\/(\d+)/)?.[1]
  const tweet = pickFocalTweet(result.posts, requestedId)
  if (!tweet) {
    return {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ error: 'Post not found or unavailable.', code: 'not_found' }),
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    Vary: 'Accept, User-Agent',
    'X-Converter': 'x-md',
    'X-Embed': '1',
    'X-Source': result.source,
    'X-Post-Count': String(result.postCount),
    'X-Warnings': String(result.warnings.length),
    'X-Cache': result.cache.toUpperCase(),
  }
  if (result.cache !== 'bypass') {
    headers['Cache-Control'] = 'public, max-age=0, must-revalidate'
    const ttl = Number.parseInt(process.env.CACHE_TTL_SECONDS ?? '3600', 10)
    const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 3600
    headers['Vercel-CDN-Cache-Control'] = `public, s-maxage=${seconds}, stale-while-revalidate=86400`
  }

  return { status: 200, headers, body: buildEmbedHtml(tweet, options) }
}

/**
 * Bound a caller-supplied string before it is echoed back.
 *
 * `/oembed` reflects its query into the response, so without a clamp anyone
 * could make x.pcstyle.dev serve arbitrary text under our own domain. Control
 * characters and angle brackets are dropped outright — an unfurl label never
 * needs either — and the rest is capped at a length a preview card can show.
 */
function echoable(value: string | null | undefined, max = 200): string | undefined {
  if (!value) return undefined
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').trim()
  return cleaned ? cleaned.slice(0, max) : undefined
}

export function oembedPayload(query: OEmbedQuery, origin: string): Record<string, string> {
  const fromUrl = query.url ? parseStatusUrlSafe(query.url) : undefined
  const handle = echoable(query.author, 15)
  const author = fromUrl?.handle || (handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : undefined) || 'i'
  const status = fromUrl?.id || (/^\d{1,25}$/.test(query.status ?? '') ? query.status : undefined) || '0'
  const provider = echoable(query.provider, 60)
  const statusUrl = fromUrl?.canonicalUrl ?? `https://x.com/${encodeURIComponent(author)}/status/${status}`
  return {
    author_name: echoable(query.text) || 'Embed',
    author_url: statusUrl,
    provider_name: provider || SITE_NAME,
    provider_url: provider ? statusUrl : origin,
    title: 'Embed',
    type: provider ? 'rich' : 'link',
    version: '1.0',
  }
}

function parseStatusUrlSafe(raw: string): { handle: string; id: string; canonicalUrl: string } | undefined {
  try {
    const parsed = new URL(raw)
    const match = /^\/([^/?#]+)\/status\/(\d+)\/?$/.exec(parsed.pathname)
    if (!match) return undefined
    return {
      handle: match[1],
      id: match[2],
      canonicalUrl: `https://x.com/${match[1]}/status/${match[2]}`,
    }
  } catch {
    return undefined
  }
}

export function oembedResponse(
  query: OEmbedQuery,
  origin: string,
): { status: number; headers: Record<string, string>; body: string } {
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    },
    body: JSON.stringify(oembedPayload(query, origin)),
  }
}
