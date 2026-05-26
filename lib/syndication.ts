import { ConvertError } from './errors.js'
import type { FxArticle, FxArticleBlock, FxMedia, FxMediaItem, FxTweet } from './fxtwitter.js'

const SYNDICATION_BASE = 'https://cdn.syndication.twimg.com/tweet-result'
const UA = 'Mozilla/5.0 (compatible; x-md/1.0)'

interface SyndicationUser {
  name?: string
  screen_name?: string
  profile_image_url_https?: string
  description?: string
  location?: string
  followers_count?: number
  friends_count?: number
  statuses_count?: number
  created_at?: string
  verified?: boolean
  url?: string
  entities?: { url?: { urls?: Array<{ display_url?: string; expanded_url?: string }> } }
}

interface SyndicationMedia {
  type?: string
  media_url_https?: string
  url?: string
  video_info?: {
    variants?: Array<{ url?: string; content_type?: string; bitrate?: number }>
  }
}

interface SyndicationArticle {
  title?: string
  preview_text?: string
  cover_media?: { media_info?: { original_img_url?: string } }
}

interface SyndicationTweet {
  id_str?: string
  text?: string
  created_at?: string
  favorite_count?: number
  conversation_count?: number
  lang?: string
  user?: SyndicationUser
  mediaDetails?: SyndicationMedia[]
  photos?: SyndicationMedia[]
  video?: SyndicationMedia
  quoted_status_result?: { result?: { legacy?: SyndicationTweet; tweet?: SyndicationTweet } }
  article?: SyndicationArticle
  entities?: { media?: SyndicationMedia[] }
}

function mapMedia(raw: SyndicationTweet): FxMedia | undefined {
  const items: SyndicationMedia[] = [
    ...(raw.mediaDetails ?? []),
    ...(raw.photos ?? []),
    ...(raw.entities?.media ?? []),
    ...(raw.video ? [raw.video] : []),
  ]
  if (items.length === 0) return undefined

  const photos: FxMediaItem[] = []
  const videos: FxMediaItem[] = []
  const animated: FxMediaItem[] = []

  for (const m of items) {
    const type = (m.type ?? 'photo').toLowerCase()
    const photoUrl = m.media_url_https ?? m.url
    const videoVariant = m.video_info?.variants
      ?.filter((v) => v.content_type?.includes('video/mp4'))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0]

    if (type === 'photo') {
      if (photoUrl) photos.push({ type: 'photo', url: photoUrl, thumbnail_url: photoUrl })
    } else if (type === 'video') {
      videos.push({ type: 'video', url: videoVariant?.url ?? photoUrl, thumbnail_url: photoUrl })
    } else if (type === 'animated_gif') {
      animated.push({ type: 'animated_gif', url: videoVariant?.url ?? photoUrl, thumbnail_url: photoUrl })
    }
  }

  const media: FxMedia = {}
  if (photos.length) media.photos = photos
  if (videos.length) media.videos = videos
  if (animated.length) media.animated = animated
  return Object.keys(media).length ? media : undefined
}

function mapArticle(raw?: SyndicationArticle): FxArticle | undefined {
  if (!raw?.title && !raw?.preview_text) return undefined
  const blocks: FxArticleBlock[] = []
  if (raw.preview_text) blocks.push({ type: 'unstyled', text: raw.preview_text })
  return {
    title: raw.title,
    preview_text: raw.preview_text,
    cover_media: raw.cover_media,
    content: blocks.length ? { blocks } : undefined,
  }
}

function mapUser(user?: SyndicationUser): FxTweet['author'] {
  if (!user) return undefined
  const website = user.entities?.url?.urls?.[0]
  return {
    name: user.name,
    screen_name: user.screen_name,
    url: user.screen_name ? `https://x.com/${user.screen_name}` : user.url,
    description: user.description,
    location: user.location,
    followers: user.followers_count,
    following: user.friends_count,
    statuses: user.statuses_count,
    joined: user.created_at,
    avatar_url: user.profile_image_url_https,
    website: website ? { url: website.expanded_url, display_url: website.display_url } : undefined,
    verification: { verified: user.verified },
  }
}

function mapSyndicationTweet(raw: SyndicationTweet, handle: string, id: string): FxTweet {
  const screenName = raw.user?.screen_name ?? handle
  const quoted = raw.quoted_status_result?.result?.legacy ?? raw.quoted_status_result?.result?.tweet

  return {
    id: raw.id_str ?? id,
    text: raw.text,
    created_at: raw.created_at,
    url: `https://x.com/${screenName}/status/${raw.id_str ?? id}`,
    author: mapUser(raw.user),
    likes: raw.favorite_count,
    replies: raw.conversation_count,
    lang: raw.lang,
    media: mapMedia(raw),
    article: mapArticle(raw.article),
    quote: quoted ? mapSyndicationTweet(quoted, screenName, quoted.id_str ?? '') : undefined,
  }
}

export async function fetchSyndicationStatus(handle: string, id: string): Promise<FxTweet> {
  let response: Response
  try {
    const url = `${SYNDICATION_BASE}?id=${encodeURIComponent(id)}&lang=en&token=0`
    response = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  } catch {
    throw new ConvertError(502, 'Failed to reach X syndication API.', 'syndication_network')
  }

  if (!response.ok) {
    throw new ConvertError(
      response.status === 404 ? 404 : 502,
      'Post not found via syndication API.',
      'syndication_error',
    )
  }

  const data = (await response.json()) as SyndicationTweet
  if (!data?.text && !data?.article) {
    throw new ConvertError(404, 'Post not found via syndication API.', 'syndication_empty')
  }

  return mapSyndicationTweet(data, handle, id)
}
