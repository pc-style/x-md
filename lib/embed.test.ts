import { describe, expect, test } from 'vitest'
import type { ConvertSuccess } from './converter.js'
import {
  buildEmbedHtml,
  embedDescription,
  embedResponse,
  formatCount,
  isEmbedUserAgent,
  oembedPayload,
  pickFocalTweet,
  socialProof,
  supportsNativeMultiImage,
} from './embed.js'
import type { FxTweet } from './fxtwitter.js'

const photoTweet: FxTweet = {
  id: '2087920734702022870',
  url: 'https://x.com/nthglsn/status/2087920734702022870',
  text: '> X offers to sell the @claw handle\n\nWhat should I do?',
  likes: 469,
  retweets: 14,
  replies: 38,
  views: 78400,
  lang: 'en',
  author: {
    name: 'Nathan',
    screen_name: 'nthglsn',
    avatar_url: 'https://pbs.twimg.com/profile.jpg',
  },
  media: {
    photos: [
      { type: 'photo', url: 'https://pbs.twimg.com/one.jpg', width: 1226, height: 576, alt: 'deal screenshot' },
      { type: 'photo', url: 'https://pbs.twimg.com/two.jpg', width: 1324, height: 524 },
    ],
    mosaic: {
      type: 'mosaic_photo',
      formats: { jpeg: 'https://mosaic.fxtwitter.com/jpeg/one/two' },
    },
  },
}

const quoted: FxTweet = {
  id: '1',
  text: 'hello <world> & "friends"',
  author: { name: 'Ada', screen_name: 'ada' },
  quote: {
    id: '2',
    text: 'quoted line',
    author: { name: 'Grace', screen_name: 'hopper' },
  },
}

describe('embed user agents', () => {
  test('recognizes Discord, Telegram, and Slack preview bots', () => {
    expect(isEmbedUserAgent('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')).toBe(true)
    expect(isEmbedUserAgent('TelegramBot (like TwitterBot)')).toBe(true)
    expect(isEmbedUserAgent('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe(true)
    expect(isEmbedUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:92.0) Gecko/20100101 Firefox/92.0')).toBe(false)
    expect(isEmbedUserAgent('Mozilla/5.0 Telegram iOS')).toBe(false)
    expect(isEmbedUserAgent('Mozilla/5.0 Discord/0.0.300')).toBe(false)
    expect(isEmbedUserAgent('curl/8.7.1')).toBe(false)
    expect(isEmbedUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0')).toBe(false)
  })

  test('only Discord-like UAs get native multi-image tags', () => {
    expect(supportsNativeMultiImage('Discordbot/2.0')).toBe(true)
    expect(supportsNativeMultiImage('TelegramBot')).toBe(false)
  })
})

describe('counts and description', () => {
  test('formats compact social-proof counts', () => {
    expect(formatCount(38)).toBe('38')
    expect(formatCount(78400)).toBe('78.4K')
    expect(formatCount(999_999)).toBe('1.00M')
    expect(formatCount(1_250_000)).toBe('1.25M')
    expect(socialProof(photoTweet)).toBe('💬 38   🔁 14   ❤️ 469   👁️ 78.4K')
  })

  test('appends quote attribution and poll bars', () => {
    const withPoll: FxTweet = {
      ...quoted,
      poll: {
        choices: [
          { label: 'Yes', percentage: 75 },
          { label: 'No', percentage: 25 },
        ],
        total_votes: 12,
        time_left_en: 'Final results',
      },
    }
    const text = embedDescription(withPoll)
    expect(text).toContain('hello <world> & "friends"')
    expect(text).toContain('Quoting Grace (@hopper)')
    expect(text).toContain('quoted line')
    expect(text).toContain('Yes\u2000\u2000(75%)')
    expect(text).toContain('12 votes · Final results')
  })

  test('picks the requested post from a conversation', () => {
    const posts: FxTweet[] = [
      { id: '1', context: 'parent' },
      { id: '2', context: 'post' },
      { id: '3', context: 'reply' },
    ]
    expect(pickFocalTweet(posts, '2')?.id).toBe('2')
    expect(pickFocalTweet(posts)?.id).toBe('2')
  })
})

describe('embed HTML', () => {
  test('Discord gets repeated og:image tags and oEmbed discovery', () => {
    const html = buildEmbedHtml(photoTweet, {
      origin: 'https://x.pcstyle.dev',
      userAgent: 'Discordbot/2.0',
    })
    expect(html).toContain('og:title" content="Nathan (@nthglsn)"')
    expect(html).toContain('og:description" content="&gt; X offers to sell the @claw handle')
    expect(html).toContain('twitter:card" content="summary_large_image"')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/one.jpg"')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/two.jpg"')
    expect(html).not.toContain('mosaic.fxtwitter.com')
    expect(html).toContain('og:image:alt" content="deal screenshot"')
    expect(html).toContain('type="application/json+oembed"')
    expect(html).toContain('https://x.pcstyle.dev/oembed?')
    expect(html).toContain('url=https%3A%2F%2Fx.com%2Fnthglsn%2Fstatus%2F2087920734702022870')
    expect(html).toContain('text=%F0%9F%92%AC+38+++%F0%9F%94%81+14+++%E2%9D%A4%EF%B8%8F+469+++%F0%9F%91%81%EF%B8%8F+78.4K')
  })

  test('Telegram uses the mosaic for multi-photo posts', () => {
    const html = buildEmbedHtml(photoTweet, {
      origin: 'https://x.pcstyle.dev',
      userAgent: 'TelegramBot',
    })
    expect(html).toContain('https://mosaic.fxtwitter.com/jpeg/one/two')
    expect(html).not.toContain('https://pbs.twimg.com/two.jpg')
  })

  test('Telegram uses the quoted mosaic for quote-only multi-photo posts', () => {
    const html = buildEmbedHtml(
      {
        id: '5',
        text: 'look',
        author: { name: 'Ada', screen_name: 'ada' },
        quote: {
          id: '6',
          text: 'photos',
          author: { name: 'Grace', screen_name: 'hopper' },
          media: {
            photos: [
              { type: 'photo', url: 'https://pbs.twimg.com/q1.jpg' },
              { type: 'photo', url: 'https://pbs.twimg.com/q2.jpg' },
            ],
            mosaic: { formats: { jpeg: 'https://mosaic.fxtwitter.com/jpeg/quote' } },
          },
        },
      },
      { origin: 'https://x.pcstyle.dev', userAgent: 'TelegramBot' },
    )
    expect(html).toContain('https://mosaic.fxtwitter.com/jpeg/quote')
    expect(html).not.toContain('https://pbs.twimg.com/q2.jpg')
  })

  test('does not emit HLS URLs as og:video', () => {
    const html = buildEmbedHtml(
      {
        id: '8',
        text: 'stream',
        author: { name: 'Ada', screen_name: 'ada' },
        media: {
          videos: [{ type: 'video', url: 'https://video.twimg.com/clip.m3u8', thumbnail_url: 'https://pbs.twimg.com/thumb.jpg' }],
        },
      },
      { origin: 'https://x.pcstyle.dev', userAgent: 'Discordbot/2.0' },
    )
    expect(html).not.toContain('og:video')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/thumb.jpg"')
  })

  test('videos emit player-stream tags and scaled dimensions', () => {
    const html = buildEmbedHtml(
      {
        id: '9',
        text: 'watch this',
        likes: 12,
        author: { name: 'Ada', screen_name: 'ada' },
        media: {
          videos: [
            {
              type: 'video',
              url: 'https://video.twimg.com/low.mp4',
              thumbnail_url: 'https://pbs.twimg.com/thumb.jpg',
              width: 3840,
              height: 2160,
              variants: [
                { url: 'https://video.twimg.com/low.mp4', content_type: 'video/mp4', bitrate: 500 },
                { url: 'https://video.twimg.com/high.mp4', content_type: 'video/mp4', bitrate: 4000 },
              ],
            },
          ],
        },
      },
      { origin: 'https://x.pcstyle.dev', userAgent: 'Discordbot/2.0' },
    )
    expect(html).toContain('twitter:card" content="player"')
    expect(html).toContain('og:video" content="https://video.twimg.com/high.mp4"')
    expect(html).toContain('og:video:width" content="1920"')
    expect(html).toContain('og:video:height" content="1080"')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/thumb.jpg"')
    expect(html).toContain('provider=')
  })

  test('Slack gets a video thumbnail instead of an unsupported player card', () => {
    const html = buildEmbedHtml(
      {
        id: '9',
        text: 'watch this',
        author: { name: 'Ada', screen_name: 'ada' },
        media: {
          videos: [
            {
              type: 'video',
              url: 'https://video.twimg.com/video.mp4',
              thumbnail_url: 'https://pbs.twimg.com/thumb.jpg',
            },
          ],
        },
      },
      {
        origin: 'https://x.pcstyle.dev',
        userAgent: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      },
    )
    expect(html).toContain('twitter:card" content="summary_large_image"')
    expect(html).toContain('twitter:image" content="https://pbs.twimg.com/thumb.jpg"')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/thumb.jpg"')
    expect(html).not.toContain('og:video')
  })

  test('text-only posts fall back to the author avatar', () => {
    const html = buildEmbedHtml(
      { id: '3', text: 'just words', author: { name: 'Ada', screen_name: 'ada', avatar_url: 'https://pbs.twimg.com/ada.jpg' } },
      { origin: 'https://x.pcstyle.dev' },
    )
    expect(html).toContain('twitter:card" content="summary"')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/ada.jpg"')
  })

  test('escapes attribute-breaking characters in titles and descriptions', () => {
    const html = buildEmbedHtml(quoted, { origin: 'https://x.pcstyle.dev' })
    expect(html).toContain('hello &lt;world&gt; &amp; &quot;friends&quot;')
    expect(html).toContain('Quoting Grace (@hopper)')
  })
})

describe('embed and oEmbed responses', () => {
  const result: ConvertSuccess = {
    body: '# unused',
    warnings: [],
    canonicalUrl: 'https://x.com/nthglsn/status/2087920734702022870',
    format: 'markdown',
    postCount: 1,
    source: 'fxtwitter',
    cache: 'miss',
    posts: [photoTweet],
    compact: true,
  }

  test('embedResponse wraps the focal post as HTML', () => {
    const response = embedResponse(result, { origin: 'https://x.pcstyle.dev', userAgent: 'Discordbot/2.0' })
    expect(response.status).toBe(200)
    expect(response.headers['Content-Type']).toContain('text/html')
    expect(response.headers.Vary).toBe('Accept, User-Agent')
    expect(response.headers['X-Embed']).toBe('1')
    expect(response.body).toContain('Nathan (@nthglsn)')
  })

  test('bypassed not-found previews cannot be cached', () => {
    const response = embedResponse({ ...result, posts: [], cache: 'bypass' }, { origin: 'https://mdfromx.com' })
    expect(response.status).toBe(404)
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(response.headers['Vercel-CDN-Cache-Control']).toBe('no-store')
  })

  test('bypassed HTML previews cannot be cached', () => {
    const response = embedResponse({ ...result, cache: 'bypass' }, { origin: 'https://mdfromx.com', userAgent: 'Discordbot/2.0' })
    expect(response.headers['Cache-Control']).toBe('no-store')
    expect(response.headers['Vercel-CDN-Cache-Control']).toBe('no-store')
  })

  test('oembedPayload maps query fields the way Discord reads them', () => {
    expect(
      oembedPayload(
        {
          url: 'https://x.com/nthglsn/status/2087920734702022870',
          text: '💬 38   🔁 14',
          author: 'nthglsn',
          status: '2087920734702022870',
        },
        'https://x.pcstyle.dev',
      ),
    ).toEqual({
      author_name: '💬 38   🔁 14',
      author_url: 'https://x.com/nthglsn/status/2087920734702022870',
      provider_name: 'x.md',
      provider_url: 'https://x.pcstyle.dev',
      title: 'Embed',
      type: 'link',
      version: '1.0',
    })
  })

  test('rejects an over-long author instead of truncating it into a handle', () => {
    expect(oembedPayload({ author: 'a'.repeat(30), status: '1' }, 'https://x.pcstyle.dev').author_url).toBe(
      'https://x.com/i/status/1',
    )
    expect(oembedPayload({ author: 'a'.repeat(15), status: '1' }, 'https://x.pcstyle.dev').author_url).toBe(
      `https://x.com/${'a'.repeat(15)}/status/1`,
    )
  })

  test('marks video oEmbed payloads as rich so Slack renders the media', () => {
    expect(
      oembedPayload(
        {
          url: 'https://x.com/hams/status/2089772419175047410',
          text: '❤️ 1.1K',
          provider: '❤️ 1.1K',
        },
        'https://x.pcstyle.dev',
      ),
    ).toMatchObject({
      provider_name: '❤️ 1.1K',
      provider_url: 'https://x.com/hams/status/2089772419175047410',
      type: 'rich',
    })
  })
})

describe('article previews', () => {
  const article: FxTweet = {
    id: '2098047492772249730', text: 'https://x.com/i/article/2098045587400658947',
    author: { name: 'Mustafa Ali', screen_name: 'mustafa01ali', avatar_url: 'https://pbs.twimg.com/avatar.jpg' },
    article: { title: 'Shopify is moving from React Native to Native', preview_text: 'Moving our mobile apps back to Swift and Kotlin.', cover_media: { media_info: { original_img_url: 'https://pbs.twimg.com/article.jpg' } } },
  }
  test('uses article title, excerpt and cover instead of a naked URL and avatar', () => {
    const html = buildEmbedHtml(article, { origin: 'https://mdfromx.com', userAgent: 'Discordbot/2.0' })
    expect(html).toContain('og:title" content="Shopify is moving from React Native to Native')
    expect(html).toContain('Moving our mobile apps back to Swift and Kotlin.')
    expect(html).toContain('og:image" content="https://pbs.twimg.com/article.jpg')
    expect(html).toContain('summary_large_image')
    expect(html).toContain('Mustafa Ali')
  })
  test('falls back to article blocks when the preview is missing', () => {
    expect(embedDescription({ ...article, article: { title: 'Title', content: { blocks: [{ text: 'First paragraph.' }] } } })).toContain('First paragraph.')
  })
})
