import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const fetchSearchTweets = vi.fn()
const fetchSearchProfiles = vi.fn()
vi.mock('@the-convocation/twitter-scraper', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@the-convocation/twitter-scraper')>()
  return {
    ...actual,
    Scraper: class { setCookies = vi.fn(async () => {}); fetchSearchTweets = fetchSearchTweets; fetchSearchProfiles = fetchSearchProfiles },
  }
})

import { ApiError, AuthenticationError, type Tweet } from '@the-convocation/twitter-scraper'
import { resetRateLimits } from './ratelimit.js'
import { resetXSessions, searchXStatuses, searchXUsers, tweetToFx, xsearchConfigured } from './xsearch.js'

const sessions = [
  { id: 'a', authToken: 'tokA', ct0: 'csrfA' },
  { id: 'b', authToken: 'tokB', ct0: 'csrfB' },
]

function tweet(overrides: Partial<Tweet> = {}): Tweet {
  return { hashtags: [], mentions: [], photos: [], videos: [], thread: [], urls: [], ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetXSessions(sessions)
  resetRateLimits()
})
afterEach(() => resetXSessions(undefined))

describe('tweetToFx', () => {
  test('maps ids, author, metrics, media, reply parent and quote', () => {
    const fx = tweetToFx(tweet({
      id: '1', username: 'ada', name: 'Ada', userId: '7', text: 'hi', likes: 3, retweets: 2, replies: 1, views: 50, bookmarkCount: 4,
      timeParsed: new Date('2026-09-06T16:24:21Z'), timestamp: 1788712, permanentUrl: 'https://twitter.com/ada/status/1',
      inReplyToStatusId: '0', photos: [{ id: 'p', url: 'https://img/p.jpg', alt_text: 'alt' }],
      quotedStatus: tweet({ id: '2', username: 'bob', text: 'q' }),
    }))
    expect(fx).toMatchObject({
      id: '1', text: 'hi', likes: 3, retweets: 2, replies: 1, views: 50, bookmarks: 4, created_timestamp: 1788712,
      url: 'https://twitter.com/ada/status/1',
      author: { name: 'Ada', screen_name: 'ada', url: 'https://x.com/ada', id: '7' },
      replying_to_status: ['0'],
      media: { photos: [{ type: 'photo', url: 'https://img/p.jpg', alt: 'alt' }] },
      quote: { id: '2', author: { screen_name: 'bob' } },
    })
    expect(fx.created_at).toBe('Sun Sep 06 16:24:21 +0000 2026')
    expect(tweetToFx(tweet({ id: '3', username: 'c' })).url).toBe('https://x.com/c/status/3')
  })
})

describe('searchXStatuses', () => {
  test('is configured when sessions exist and returns a mapped page with cursors', async () => {
    expect(xsearchConfigured()).toBe(true)
    fetchSearchTweets.mockResolvedValue({ tweets: [tweet({ id: '1', username: 'ada' })], next: 'N', previous: 'P' })
    const page = await searchXStatuses('q', 'top', undefined, 5)
    expect(fetchSearchTweets).toHaveBeenCalledWith('q', 5, 0, undefined)
    expect(page).toMatchObject({ results: [{ id: '1' }], cursor: { bottom: 'N', top: 'P' } })
  })

  test('rotates to the next session on 429 and disables a session on auth failure', async () => {
    const limited = new ApiError(new Response('', { status: 429 }), {})
    fetchSearchTweets
      .mockRejectedValueOnce(limited)
      .mockResolvedValueOnce({ tweets: [tweet({ id: '2', username: 'b' })] })
    const first = await searchXStatuses('q', 'latest')
    expect(first.results[0]?.id).toBe('2')
    expect(fetchSearchTweets).toHaveBeenCalledTimes(2)

    // a is cooling; b now fails auth -> nothing left -> 503
    fetchSearchTweets.mockReset().mockRejectedValue(new AuthenticationError('bad'))
    await expect(searchXStatuses('q', 'latest')).rejects.toMatchObject({ status: 503, code: 'search_unavailable' })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(1)
    await expect(searchXStatuses('q', 'latest')).rejects.toMatchObject({ code: 'search_unavailable' })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(1)
  })

  test('stops calling X once the pool budget (100 per session per 15 min) is spent', async () => {
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    for (let i = 0; i < 200; i += 1) await searchXStatuses('q', 'latest')
    expect(fetchSearchTweets).toHaveBeenCalledTimes(200)
    await expect(searchXStatuses('q', 'latest')).rejects.toMatchObject({ code: 'search_unavailable' })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(200)
  })

  test.each([['latest', 1], ['top', 0], ['photos', 2], ['media', 2], ['videos', 3]])('maps %s and caps upstream count', async (feed, mode) => {
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    await searchXStatuses('q', feed as string, 'cursor', 50)
    expect(fetchSearchTweets).toHaveBeenCalledWith('q', 20, mode, 'cursor')
  })

  test('maps user profiles and shares the account budget with post searches', async () => {
    resetXSessions([sessions[0]!])
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    fetchSearchProfiles.mockResolvedValue({ profiles: [{ userId: '1', username: 'ada', name: 'Ada', biography: 'Builder', followersCount: 42 }], next: 'N' })
    const result = await searchXUsers('ada', 'C', 50)
    expect(fetchSearchProfiles).toHaveBeenCalledWith('ada', 20, 'C')
    expect(result).toMatchObject({ results: [{ screen_name: 'ada', description: 'Builder', followers: 42 }], cursor: { bottom: 'N' } })
    for (let i = 0; i < 99; i++) await searchXStatuses('q', 'latest')
    await expect(searchXUsers('ada')).rejects.toMatchObject({ code: 'search_unavailable' })
    expect(fetchSearchProfiles).toHaveBeenCalledTimes(1)
  })

  test('503s with no sessions', async () => {
    resetXSessions([])
    expect(xsearchConfigured()).toBe(false)
    await expect(searchXStatuses('q', 'latest')).rejects.toMatchObject({ code: 'search_unavailable' })
  })
})
