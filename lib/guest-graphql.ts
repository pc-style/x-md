import { ConvertError } from './errors.js'
import type { FxArticle, FxAuthor, FxListResponse, FxMedia, FxMediaItem, FxPoll, FxTweet } from './fxtwitter.js'

/**
 * Prototype provider: X's own web GraphQL, read logged out with guest tokens.
 * No accounts or cookies. It maps into the same `FxTweet` / `FxAuthor` shapes
 * the FxTwitter fetcher returns, so it can be compared against it (or slotted
 * in as a tier) without touching the Markdown layer.
 *
 * What a guest can read (checked 2026-10-29): `TweetResultByRestId`,
 * `UserByScreenName` and `UserTweets`. `TweetDetail`, `UserTweetsAndReplies`
 * and `UserMedia` answer 404 to guests, so threads are assembled by walking
 * reply parents one post at a time, and a guest `UserTweets` is X's
 * logged-out highlights of an account rather than its latest posts.
 *
 * The web client's bearer is read from `X_GUEST_BEARER` and never committed.
 * Guest tokens are activated with it and held in a small pool: requests rotate
 * across the pool, a token that hits its rate limit sits out until X's reset,
 * and one X rejects is dropped and replaced.
 */

const API = 'https://api.x.com'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 10_000
/** Guest tokens live about three hours; retire them well before that. */
const TOKEN_TTL_MS = 2 * 60 * 60_000
const POOL_SIZE = Math.max(1, Number(process.env.X_GUEST_POOL_SIZE) || 3)
const MAX_ATTEMPTS = 3
/** Parent posts walked above a reply before the thread is cut off. */
export const GUEST_MAX_PARENTS = 10

const QUERY_IDS = {
  TweetResultByRestId: 'Xl5pC_lBk_gcO2ItU39DQw',
  UserByScreenName: 'x3RLKWW1Tl7JgU7YtGxuzw',
  UserTweets: 'E3opETHurmVJflFsUBVuUQ',
} as const
type Operation = keyof typeof QUERY_IDS

const FEATURES = JSON.stringify({
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  longform_notetweets_consumption_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  articles_preview_enabled: true,
  view_counts_everywhere_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  standardized_nudges_misinfo: true,
  responsive_web_edit_tweet_api_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  hidden_profile_subscriptions_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  responsive_web_enhance_cards_enabled: false,
})
const FIELD_TOGGLES = JSON.stringify({ withArticleRichContentState: true, withArticlePlainText: false })

/** One upstream round trip, as reported in a response's timing block. The token is a pool slot, never its value. */
export interface GuestCall {
  op: Operation | 'guest/activate'
  status: number | 'network_error'
  ms: number
  token?: number
}
export type GuestTrace = GuestCall[]

interface GuestToken {
  value: string
  slot: number
  issuedAt: number
  coolUntil: number
}

let tokens: GuestToken[] = []
let activating: Promise<GuestToken> | undefined
let rotation = 0
let nextSlot = 1

/** Test hook. */
export function resetGuestPool(): void {
  tokens = []
  activating = undefined
  rotation = 0
  nextSlot = 1
}

export function guestPoolStats(): { size: number; target: number; cooling: number } {
  const now = Date.now()
  return { size: tokens.length, target: POOL_SIZE, cooling: tokens.filter((token) => token.coolUntil > now).length }
}

function bearer(): string {
  const value = process.env.X_GUEST_BEARER?.trim()
  if (!value) throw new ConvertError(503, 'Guest GraphQL is not configured (X_GUEST_BEARER).', 'upstream_unavailable', 60)
  return value
}

async function timedFetch(url: string, init: RequestInit, trace: GuestTrace, call: Omit<GuestCall, 'status' | 'ms'>): Promise<Response> {
  const started = performance.now()
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    trace.push({ ...call, status: response.status, ms: Math.round(performance.now() - started) })
    return response
  } catch {
    trace.push({ ...call, status: 'network_error', ms: Math.round(performance.now() - started) })
    throw new ConvertError(502, 'Failed to reach X.', 'upstream_unavailable', 10)
  }
}

function activate(trace: GuestTrace): Promise<GuestToken> {
  activating ??= (async () => {
    try {
      const response = await timedFetch(`${API}/1.1/guest/activate.json`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer()}`, 'user-agent': UA },
      }, trace, { op: 'guest/activate' })
      if (response.status === 429) throw new ConvertError(503, 'X is rate limiting guest activation.', 'upstream_rate_limited', 60)
      const data = await response.json().catch(() => ({})) as { guest_token?: string }
      if (!response.ok || !data.guest_token) throw new ConvertError(503, `X refused a guest token (${response.status}).`, 'upstream_unavailable', 30)
      const token = { value: data.guest_token, slot: nextSlot++, issuedAt: Date.now(), coolUntil: 0 }
      tokens.push(token)
      return token
    } finally {
      activating = undefined
    }
  })()
  return activating
}

/** A healthy token other than `avoid`, round robin; tops the pool up in the background while it is short. */
async function acquire(trace: GuestTrace, avoid?: GuestToken): Promise<GuestToken> {
  const now = Date.now()
  tokens = tokens.filter((token) => now - token.issuedAt < TOKEN_TTL_MS)
  const healthy = tokens.filter((token) => token.coolUntil <= now && token !== avoid)
  if (healthy.length > 0) {
    if (tokens.length < POOL_SIZE && !activating) void activate([]).catch(() => {})
    rotation = (rotation + 1) % healthy.length
    return healthy[rotation]
  }
  if (tokens.length >= POOL_SIZE) {
    // Every token is cooling: retire the one that recovers last to make room.
    const latest = [...tokens].sort((a, b) => b.coolUntil - a.coolUntil)[0]
    tokens = tokens.filter((token) => token !== latest)
  }
  return activate(trace)
}

function resetAt(response: Response): number {
  const reset = Number(response.headers.get('x-rate-limit-reset'))
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : Date.now() + 60_000
}

interface GraphQLBody<T> {
  data?: T
  errors?: Array<{ message?: string; code?: number }>
}

async function graphql<T>(op: Operation, variables: Record<string, unknown>, trace: GuestTrace): Promise<T> {
  const url = new URL(`${API}/graphql/${QUERY_IDS[op]}/${op}`)
  url.searchParams.set('variables', JSON.stringify(variables))
  url.searchParams.set('features', FEATURES)
  url.searchParams.set('fieldToggles', FIELD_TOGGLES)

  let previous: GuestToken | undefined
  for (let attempt = 1; ; attempt += 1) {
    const token = await acquire(trace, previous)
    previous = token
    const response = await timedFetch(url.href, {
      headers: {
        authorization: `Bearer ${bearer()}`,
        'x-guest-token': token.value,
        'content-type': 'application/json',
        'user-agent': UA,
      },
    }, trace, { op, token: token.slot })

    if (Number(response.headers.get('x-rate-limit-remaining') ?? 1) <= 0) token.coolUntil = resetAt(response)
    if (response.status === 429) {
      token.coolUntil = resetAt(response)
      if (attempt < MAX_ATTEMPTS) continue
      throw new ConvertError(503, 'X is rate limiting guest reads.', 'upstream_rate_limited', Math.max(1, Math.ceil((token.coolUntil - Date.now()) / 1000)))
    }
    const body = await response.json().catch(() => undefined) as GraphQLBody<T> | undefined
    // 239 is "Bad guest token": drop it and get another.
    if (response.status === 401 || response.status === 403 || body?.errors?.some((error) => error.code === 239)) {
      tokens = tokens.filter((held) => held !== token)
      if (attempt < MAX_ATTEMPTS) continue
      throw new ConvertError(503, 'X rejected the guest tokens.', 'upstream_unavailable', 30)
    }
    if (response.status === 404) throw new ConvertError(503, `X no longer serves ${op} to guests.`, 'upstream_unavailable', 300)
    if (response.status >= 500 || !body) throw new ConvertError(503, `X answered ${response.status}.`, 'upstream_unavailable', 30)
    if (!body.data) throw new ConvertError(502, body.errors?.[0]?.message ?? 'X returned no data.', 'partial_upstream_failure', 10)
    return body.data
  }
}

/* ---- X GraphQL shapes (only the fields read here) ---- */

interface XUrl { url?: string; expanded_url?: string; display_url?: string; indices?: number[] }
interface XMention { screen_name?: string; indices?: number[] }
interface XMedia {
  id_str?: string
  type?: string
  media_url_https?: string
  ext_alt_text?: string
  original_info?: { width?: number; height?: number }
  video_info?: { duration_millis?: number; variants?: Array<{ url?: string; content_type?: string; bitrate?: number }> }
}

interface XUser {
  __typename?: string
  rest_id?: string
  reason?: string
  core?: { name?: string; screen_name?: string; created_at?: string }
  avatar?: { image_url?: string }
  location?: { location?: string }
  privacy?: { protected?: boolean }
  is_blue_verified?: boolean
  verification?: { verified?: boolean; verified_type?: string }
  legacy?: {
    name?: string
    screen_name?: string
    created_at?: string
    description?: string
    location?: string
    url?: string
    protected?: boolean
    verified_type?: string
    followers_count?: number
    friends_count?: number
    favourites_count?: number
    media_count?: number
    statuses_count?: number
    profile_image_url_https?: string
    profile_banner_url?: string
    entities?: { url?: { urls?: XUrl[] }; description?: { urls?: XUrl[] } }
  }
}

interface XCardValue { key?: string; value?: { string_value?: string } }

interface XTweet {
  __typename?: string
  rest_id?: string
  reason?: string
  tweet?: XTweet
  source?: string
  core?: { user_results?: { result?: XUser } }
  views?: { count?: string }
  note_tweet?: { note_tweet_results?: { result?: { text?: string; entity_set?: { urls?: XUrl[] } } } }
  quoted_status_result?: { result?: XTweet }
  article?: { article_results?: { result?: XArticle } }
  card?: { legacy?: { name?: string; binding_values?: XCardValue[] } }
  legacy?: {
    id_str?: string
    full_text?: string
    display_text_range?: number[]
    created_at?: string
    lang?: string
    possibly_sensitive?: boolean
    reply_count?: number
    retweet_count?: number
    favorite_count?: number
    quote_count?: number
    bookmark_count?: number
    in_reply_to_status_id_str?: string
    in_reply_to_screen_name?: string
    entities?: { urls?: XUrl[]; user_mentions?: XMention[] }
    extended_entities?: { media?: XMedia[] }
    retweeted_status_result?: { result?: XTweet }
  }
}

interface XArticle {
  title?: string
  preview_text?: string
  cover_media?: { media_info?: { original_img_url?: string } }
  content_state?: { blocks?: unknown[]; entityMap?: unknown }
  media_entities?: unknown[]
}

/* ---- mapping into the FxTwitter shapes ---- */

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
function unescapeHtml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity])
}

function expandUrls(text: string, urls: XUrl[] = []): string {
  return urls.reduce((out, entity) => entity.url && entity.expanded_url ? out.split(entity.url).join(entity.expanded_url) : out, text)
}

/** X's entity indices count code points, so slice by code point, not UTF-16 unit. */
function displayText(full: string, range?: number[]): string {
  if (!range || range.length !== 2) return full
  return Array.from(full).slice(range[0], range[1]).join('')
}

function stripTags(html?: string): string | undefined {
  return html?.replace(/<[^>]*>/g, '') || undefined
}

function avatar(url?: string): string | undefined {
  return url?.replace(/_normal(\.[a-z]+)$/i, '_200x200$1')
}

export function mapGuestUser(user?: XUser): FxAuthor | undefined {
  if (!user || user.__typename === 'UserUnavailable') return undefined
  const legacy = user.legacy ?? {}
  const screenName = user.core?.screen_name ?? legacy.screen_name
  const website = legacy.entities?.url?.urls?.[0]
  const verifiedType = user.verification?.verified_type ?? legacy.verified_type
  return {
    id: user.rest_id,
    name: user.core?.name ?? legacy.name,
    screen_name: screenName,
    url: screenName ? `https://x.com/${screenName}` : undefined,
    description: legacy.description != null ? unescapeHtml(expandUrls(legacy.description, legacy.entities?.description?.urls)) : undefined,
    location: user.location?.location ?? legacy.location,
    followers: legacy.followers_count,
    following: legacy.friends_count,
    likes: legacy.favourites_count,
    media_count: legacy.media_count,
    statuses: legacy.statuses_count,
    joined: user.core?.created_at ?? legacy.created_at,
    avatar_url: avatar(user.avatar?.image_url ?? legacy.profile_image_url_https),
    banner_url: legacy.profile_banner_url,
    protected: user.privacy?.protected ?? legacy.protected ?? false,
    website: website ? { url: website.expanded_url, display_url: website.display_url } : undefined,
    verification: {
      verified: Boolean(user.is_blue_verified || user.verification?.verified || verifiedType),
      type: verifiedType?.toLowerCase() ?? (user.is_blue_verified ? 'individual' : undefined),
    },
  }
}

function mapMedia(items: XMedia[] = []): FxMedia | undefined {
  const all: FxMediaItem[] = []
  for (const item of items) {
    const width = item.original_info?.width
    const height = item.original_info?.height
    if (item.type === 'photo') {
      const url = item.media_url_https ? `${item.media_url_https}?name=orig` : undefined
      all.push({ type: 'photo', url, thumbnail_url: item.media_url_https, width, height, alt: item.ext_alt_text })
      continue
    }
    const variants = (item.video_info?.variants ?? [])
      .filter((variant): variant is { url: string; content_type?: string; bitrate?: number } => Boolean(variant.url))
      .sort((a, b) => (b.bitrate ?? -1) - (a.bitrate ?? -1))
    const best = variants.find((variant) => variant.content_type === 'video/mp4')
    all.push({
      type: item.type === 'animated_gif' ? 'gif' : 'video',
      url: best?.url ?? item.media_url_https,
      thumbnail_url: item.media_url_https,
      width,
      height,
      duration_ms: item.video_info?.duration_millis,
      format: best?.content_type,
      bitrate: best?.bitrate,
      alt: item.ext_alt_text,
      variants,
    })
  }
  if (all.length === 0) return undefined
  // FxTwitter files GIFs under `videos` with type `gif`; match it.
  const photos = all.filter((item) => item.type === 'photo')
  const videos = all.filter((item) => item.type !== 'photo')
  return {
    all,
    ...(photos.length ? { photos } : {}),
    ...(videos.length ? { videos } : {}),
  }
}

function mapPoll(card: XTweet['card']): FxPoll | undefined {
  if (!card?.legacy?.name || !/^poll\dchoice/.test(card.legacy.name)) return undefined
  const values = new Map((card.legacy.binding_values ?? []).map((entry) => [entry.key, entry.value?.string_value]))
  const choices = [1, 2, 3, 4].flatMap((n) => {
    const label = values.get(`choice${n}_label`)
    return label == null ? [] : [{ label, count: Number(values.get(`choice${n}_count`) ?? 0) }]
  })
  const total = choices.reduce((sum, choice) => sum + choice.count, 0)
  const endsAt = values.get('end_datetime_utc')
  const final = values.get('counts_are_final') === 'true' || (endsAt ? Date.parse(endsAt) <= Date.now() : false)
  return {
    choices: choices.map((choice) => ({ ...choice, percentage: total ? Math.round((choice.count / total) * 1000) / 10 : 0 })),
    total_votes: total,
    ends_at: endsAt,
    time_left_en: final ? 'Final results' : undefined,
  }
}

function mapArticle(article?: XArticle): FxArticle | undefined {
  if (!article?.title && !article?.content_state) return undefined
  // content_state is the same Draft.js block document FxTwitter serves, entityMap included.
  return {
    title: article.title,
    preview_text: article.preview_text,
    cover_media: article.cover_media,
    content: article.content_state as FxArticle['content'],
    ...(article.media_entities ? { media_entities: article.media_entities } : {}),
  }
}

/** Unwraps `TweetWithVisibilityResults`; anything that is not a readable tweet comes back as undefined. */
function readable(result?: XTweet): XTweet | undefined {
  const tweet = result?.__typename === 'TweetWithVisibilityResults' ? result.tweet : result
  return tweet?.legacy ? tweet : undefined
}

export function mapGuestTweet(result: XTweet, depth = 0): FxTweet {
  const tweet = readable(result) ?? result
  const legacy = tweet.legacy ?? {}
  const repost = readable(legacy.retweeted_status_result?.result)
  const author = mapGuestUser(tweet.core?.user_results?.result)
  if (repost) return { ...mapGuestTweet(repost, depth), reposted_by: author }

  const note = tweet.note_tweet?.note_tweet_results?.result
  // display_text_range indexes the HTML-escaped text, so slice before unescaping.
  const escaped = legacy.full_text ?? ''
  const full = unescapeHtml(escaped)
  const text = unescapeHtml(note?.text != null
    ? expandUrls(note.text, note.entity_set?.urls)
    : expandUrls(displayText(escaped, legacy.display_text_range), legacy.entities?.urls))
  const id = tweet.rest_id ?? legacy.id_str
  const parent = legacy.in_reply_to_status_id_str
  const quoted = depth === 0 ? readable(tweet.quoted_status_result?.result) : undefined
  const createdMs = legacy.created_at ? Date.parse(legacy.created_at) : NaN
  const article = mapArticle(tweet.article?.article_results?.result)

  return {
    type: 'status',
    id,
    url: author?.screen_name && id ? `https://x.com/${author.screen_name}/status/${id}` : undefined,
    // Like FxTwitter, an article post whose text is only the article link has no text of its own.
    text: article && /^https?:\/\/(?:x|twitter)\.com\/i\/article\/\d+$/.test(text.trim()) ? '' : text,
    raw_text: {
      text: full,
      display_text_range: legacy.display_text_range,
      facets: [
        ...(legacy.entities?.urls ?? []).flatMap((entity) => entity.url ? [{ type: 'url', original: entity.url, indices: entity.indices }] : []),
        ...(legacy.entities?.user_mentions ?? []).flatMap((entity) => entity.screen_name ? [{ type: 'mention', original: `@${entity.screen_name}`, indices: entity.indices }] : []),
      ],
    },
    created_at: legacy.created_at,
    created_timestamp: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : undefined,
    author,
    replies: legacy.reply_count,
    retweets: legacy.retweet_count,
    reposts: legacy.retweet_count,
    likes: legacy.favorite_count,
    views: tweet.views?.count != null ? Number(tweet.views.count) : null,
    bookmarks: legacy.bookmark_count,
    quotes: legacy.quote_count,
    lang: legacy.lang,
    source: stripTags(tweet.source),
    replying_to: parent ? { screen_name: legacy.in_reply_to_screen_name, status: parent } : null,
    replying_to_status: parent ? [parent] : null,
    possibly_sensitive: legacy.possibly_sensitive,
    media: mapMedia(legacy.extended_entities?.media),
    quote: quoted ? mapGuestTweet(quoted, depth + 1) : undefined,
    reposted_by: null,
    article,
    poll: mapPoll(tweet.card),
  }
}

/* ---- public reads ---- */

export async function fetchGuestStatus(id: string, trace: GuestTrace = []): Promise<FxTweet> {
  const data = await graphql<{ tweetResult?: { result?: XTweet } }>('TweetResultByRestId', {
    tweetId: id, withCommunity: false, includePromotedContent: false, withVoice: false,
  }, trace)
  const result = data.tweetResult?.result
  const tweet = readable(result)
  if (tweet) return mapGuestTweet(tweet)
  const reason = result?.reason ?? result?.tweet?.reason
  if (reason === 'Protected') throw new ConvertError(404, 'Post is private and cannot be fetched.', 'private_tweet')
  // NsfwLoggedOut, Suspended and the like: real posts a guest is not shown.
  throw new ConvertError(404, reason ? `X does not show this post to guests (${reason}).` : 'Post not found or unavailable.', 'not_found')
}

export interface GuestPostsResult {
  tweets: FxTweet[]
  source: 'guest-graphql'
}

/**
 * The post and, unless `thread` is off, the replies above it, oldest first,
 * each tagged with `context` like `fetchPosts`. Guests cannot read
 * `TweetDetail`, so nothing below the post (thread continuation, replies) is included.
 */
export async function fetchGuestPosts(id: string, thread: 'off' | 'parents' = 'parents', trace: GuestTrace = []): Promise<GuestPostsResult> {
  const post = { ...await fetchGuestStatus(id, trace), context: 'post' as const }
  const parents: FxTweet[] = []
  let parentId = thread === 'parents' && !Array.isArray(post.replying_to) ? post.replying_to?.status : undefined
  while (parentId && parents.length < GUEST_MAX_PARENTS) {
    let parent: FxTweet
    try {
      parent = await fetchGuestStatus(parentId, trace)
    } catch (error) {
      // A deleted or hidden parent ends the walk; an outage is the caller's problem.
      if (error instanceof ConvertError && error.status === 404) break
      throw error
    }
    parents.unshift({ ...parent, context: 'parent' })
    parentId = !Array.isArray(parent.replying_to) ? parent.replying_to?.status : undefined
  }
  return { tweets: [...parents, post], source: 'guest-graphql' }
}

export async function fetchGuestProfile(handle: string, trace: GuestTrace = []): Promise<FxAuthor> {
  const data = await graphql<{ user?: { result?: XUser } }>('UserByScreenName', {
    screen_name: handle, withSafetyModeUserFields: true,
  }, trace)
  const user = data.user?.result
  const profile = mapGuestUser(user)
  if (!profile?.screen_name) {
    throw new ConvertError(404, user?.reason ? `X profile unavailable (${user.reason}).` : 'X profile not found.', 'not_found')
  }
  return profile
}

interface XTimelineEntry {
  entryId?: string
  content?: {
    cursorType?: string
    value?: string
    itemContent?: { tweet_results?: { result?: XTweet } }
    items?: Array<{ item?: { itemContent?: { tweet_results?: { result?: XTweet } } } }>
  }
}

/**
 * Posts from an account's guest timeline, newest first. A guest `UserTweets`
 * is X's logged-out highlights (popular posts, years apart), not the latest
 * posts, and is empty for some smaller accounts. The pinned post is skipped.
 */
export async function fetchGuestProfileStatuses(userId: string, count = 20, cursor?: string, trace: GuestTrace = []): Promise<FxListResponse<FxTweet>> {
  const data = await graphql<{ user?: { result?: Record<string, { timeline?: { instructions?: Array<{ type?: string; entries?: XTimelineEntry[] }> } }> } }>('UserTweets', {
    userId, count: Math.min(Math.max(count, 1), 100), includePromotedContent: false,
    withQuickPromoteEligibilityTweetFields: false, withVoice: false, withV2Timeline: true,
    ...(cursor ? { cursor } : {}),
  }, trace)
  const user = data.user?.result ?? {}
  const timeline = (user.timeline_v2 ?? user.timeline)?.timeline
  const results: FxTweet[] = []
  const seen = new Set<string>()
  let bottom: string | undefined
  for (const instruction of timeline?.instructions ?? []) {
    if (instruction.type !== 'TimelineAddEntries') continue
    for (const entry of instruction.entries ?? []) {
      const content = entry.content
      if (content?.cursorType === 'Bottom') bottom = content.value
      const items = content?.itemContent ? [content.itemContent] : (content?.items ?? []).map((item) => item.item?.itemContent)
      for (const item of items) {
        const tweet = readable(item?.tweet_results?.result)
        if (!tweet) continue
        const mapped = mapGuestTweet(tweet)
        const key = mapped.reposted_by ? `rt:${mapped.id}` : mapped.id
        if (!key || seen.has(key)) continue
        seen.add(key)
        results.push(mapped)
      }
    }
  }
  results.sort((a, b) => (b.created_timestamp ?? 0) - (a.created_timestamp ?? 0))
  return { results: results.slice(0, count), cursor: bottom ? { bottom } : undefined }
}
