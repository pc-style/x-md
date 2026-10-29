import { afterEach, describe, expect, test, vi } from 'vitest'
import { fetchSyndicationChain, fetchSyndicationStatus, syndicationToken } from './syndication.js'

describe('syndication video mapping', () => {
  afterEach(() => vi.restoreAllMocks())

  test('retains dimensions, duration, best direct URL, and every MP4 variant', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id_str: '123', text: 'video', user: { screen_name: 'alice' },
      mediaDetails: [{
        type: 'video', media_url_https: 'https://img/thumb.jpg',
        original_info: { width: 1280, height: 720 },
        video_info: { duration_millis: 4500, variants: [
          { url: 'https://video/low.mp4', content_type: 'video/mp4', bitrate: 256000 },
          { url: 'https://video/high.mp4', content_type: 'video/mp4', bitrate: 832000 },
          { url: 'https://video/stream.m3u8', content_type: 'application/x-mpegURL' },
        ] },
      }],
    }), { status: 200 }))

    const tweet = await fetchSyndicationStatus('alice', '123')
    expect(tweet.media?.videos?.[0]).toMatchObject({
      url: 'https://video/high.mp4', thumbnail_url: 'https://img/thumb.jpg',
      width: 1280, height: 720, duration_ms: 4500, bitrate: 832000,
    })
    expect(tweet.media?.videos?.[0]?.variants?.map((variant) => variant.url)).toEqual([
      'https://video/high.mp4', 'https://video/low.mp4',
    ])
  })

  test('uses actual quoted_tweet identity and does not duplicate overlapping media', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id_str: '123', text: 'container', user: { screen_name: 'alice' },
      mediaDetails: [{ type: 'photo', media_url_https: 'https://img/one.jpg' }],
      photos: [{ type: 'photo', media_url_https: 'https://img/one.jpg' }],
      quoted_tweet: { id_str: '456', text: 'quote', user: { screen_name: 'bob' } },
    }), { status: 200 }))
    const tweet = await fetchSyndicationStatus('alice', '123')
    expect(tweet.media?.photos).toHaveLength(1)
    expect(tweet.quote).toMatchObject({ id: '456', url: 'https://x.com/bob/status/456' })
  })

  test('leaves a quote source absent when its own identity is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id_str: '123', text: 'container', user: { screen_name: 'alice' },
      quoted_tweet: { text: 'anonymous quote' },
    }), { status: 200 }))
    const tweet = await fetchSyndicationStatus('alice', '123')
    expect(tweet.quote?.url).toBeUndefined()
  })

  test('deduplicates overlapping fallback media projections', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id_str: '123', text: 'photos', user: { screen_name: 'alice' },
      photos: [{ type: 'photo', media_url_https: 'https://img/one.jpg' }],
      entities: { media: [
        { type: 'photo', media_url_https: 'https://img/one.jpg' },
        { type: 'photo', media_url_https: 'https://img/two.jpg' },
      ] },
    }), { status: 200 }))

    const tweet = await fetchSyndicationStatus('alice', '123')
    expect(tweet.media?.photos?.map((photo) => photo.url)).toEqual([
      'https://img/one.jpg',
      'https://img/two.jpg',
    ])
  })

  test('sends the computed token, which recent posts need', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id_str: '1585341984679469056', text: 'hi' }), { status: 200 }))
    await fetchSyndicationStatus('elonmusk', '1585341984679469056')
    expect(syndicationToken('1585341984679469056')).toBe('3uchycv2wqc')
    expect(String(fetch.mock.calls[0][0])).toContain('token=3uchycv2wqc')
  })

  test('walks the parent chain two levels per request, oldest first', async () => {
    const bodies: Record<string, unknown> = {
      4: { id_str: '4', text: 'post', in_reply_to_status_id_str: '3', in_reply_to_screen_name: 'a', parent: { id_str: '3', text: 'three', in_reply_to_status_id_str: '2' } },
      2: { id_str: '2', text: 'two', in_reply_to_status_id_str: '1', parent: { id_str: '1', text: 'one' } },
    }
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const id = new URL(String(input)).searchParams.get('id') ?? ''
      return new Response(JSON.stringify(bodies[id] ?? {}), { status: 200 })
    })
    const chain = await fetchSyndicationChain('a', '4')
    expect(chain.map((tweet) => tweet.id)).toEqual(['1', '2', '3', '4'])
    expect(chain[3].replying_to).toMatchObject({ status: '3', screen_name: 'a' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
