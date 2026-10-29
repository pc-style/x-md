import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchGuestPosts, fetchGuestStatus, mapGuestTweet, resetGuestPool, type GuestTrace } from './guest-graphql.js'

const user = { __typename: 'User', rest_id: '1', core: { name: 'Alice', screen_name: 'alice' }, legacy: {} }

function tweet(id: string, legacy: Record<string, unknown> = {}) {
  return { __typename: 'Tweet', rest_id: id, core: { user_results: { result: user } }, legacy: { full_text: 'hi', ...legacy } }
}

function graphql(result: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ data: { tweetResult: { result } } }), { status: 200, ...init })
}

let activations = 0
function activation() {
  activations += 1
  return new Response(JSON.stringify({ guest_token: `token-${activations}` }), { status: 200 })
}

describe('guest GraphQL', () => {
  beforeEach(() => {
    process.env.X_GUEST_BEARER = 'test-bearer'
    activations = 0
    resetGuestPool()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.X_GUEST_BEARER
  })

  test('slices the escaped text by display range, then unescapes and expands links', () => {
    const post = mapGuestTweet(tweet('1', {
      full_text: '&gt; a https://t.co/x https://t.co/media',
      display_text_range: [0, 21],
      entities: { urls: [{ url: 'https://t.co/x', expanded_url: 'https://example.com' }] },
    }))
    expect(post.text).toBe('> a https://example.com')
    expect(post.url).toBe('https://x.com/alice/status/1')
  })

  test('files GIFs under videos like FxTwitter, best MP4 first', () => {
    const post = mapGuestTweet(tweet('1', {
      extended_entities: { media: [{
        type: 'animated_gif', media_url_https: 'https://img/thumb.jpg',
        video_info: { variants: [
          { url: 'https://video/low.mp4', content_type: 'video/mp4', bitrate: 0 },
          { url: 'https://video/high.mp4', content_type: 'video/mp4', bitrate: 800 },
        ] },
      }] },
    }))
    expect(post.media?.videos?.[0]).toMatchObject({ type: 'gif', url: 'https://video/high.mp4', thumbnail_url: 'https://img/thumb.jpg' })
    expect(post.media?.photos).toBeUndefined()
  })

  test('a rate-limited token sits out and the read retries on another', async () => {
    const tokensUsed: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).includes('guest/activate')) return activation()
      tokensUsed.push(new Headers(init?.headers).get('x-guest-token') ?? '')
      return tokensUsed.length === 1 ? new Response('{}', { status: 429 }) : graphql(tweet('7'))
    })
    const trace: GuestTrace = []
    await expect(fetchGuestStatus('7', trace)).resolves.toMatchObject({ id: '7' })
    expect(tokensUsed).toEqual(['token-1', 'token-2'])
    expect(trace.map((call) => [call.op, call.status])).toEqual([
      ['guest/activate', 200], ['TweetResultByRestId', 429], ['guest/activate', 200], ['TweetResultByRestId', 200],
    ])
  })

  test('walks reply parents oldest first and stops at a missing one', async () => {
    const posts: Record<string, unknown> = {
      3: tweet('3', { in_reply_to_status_id_str: '2' }),
      2: tweet('2', { in_reply_to_status_id_str: '1' }),
      1: {},
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).includes('guest/activate')) return activation()
      const id = JSON.parse(new URL(String(input)).searchParams.get('variables') ?? '{}').tweetId as string
      return graphql(posts[id])
    })
    const { tweets } = await fetchGuestPosts('3')
    expect(tweets.map((post) => [post.id, post.context])).toEqual([['2', 'parent'], ['3', 'post']])
  })

  test('a protected post is private, not missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('guest/activate') ? activation() : graphql({ __typename: 'TweetUnavailable', reason: 'Protected' }))
    await expect(fetchGuestStatus('9')).rejects.toMatchObject({ status: 404, code: 'private_tweet' })
  })
})
