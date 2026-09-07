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
import { createApiKey, touchApiKey } from './apikeys.js'
import { resetKv } from './kv.js'
import { resetPool } from './pool.js'
import { resetRateLimits } from './ratelimit.js'
import { defaultKeyLimitPer15m, healthyAccountCount, poolCapacityPer15m, resetXSessions, searchRateModel, searchXStatuses, searchXUsers, tweetToFx, xsearchConfigured } from './xsearch.js'

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
  resetKv()
})
afterEach(() => {
  resetXSessions(undefined)
  vi.useRealTimers()
})

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

  test('stops calling X once the per-session budget (40 per 15 min, 2 sessions) is spent', async () => {
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    for (let i = 0; i < 80; i += 1) await searchXStatuses('q', 'latest')
    expect(fetchSearchTweets).toHaveBeenCalledTimes(80)
    await expect(searchXStatuses('q', 'latest')).rejects.toMatchObject({ code: 'search_unavailable' })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(80)
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
    for (let i = 0; i < 39; i++) await searchXStatuses('q', 'latest')
    await expect(searchXUsers('ada')).rejects.toMatchObject({ code: 'search_unavailable' })
    expect(fetchSearchProfiles).toHaveBeenCalledTimes(1)
  })

  test('503s with no sessions', async () => {
    resetXSessions([])
    expect(xsearchConfigured()).toBe(false)
    await expect(searchXStatuses('q', 'latest')).rejects.toMatchObject({ code: 'search_unavailable' })
  })
})

describe('rate model', () => {
  test('applies X cap with 20% headroom and derives the pool', () => {
    const model = searchRateModel()
    expect(model.xCapPerAccount).toBe(50)
    expect(model.perAccountBudget).toBe(40) // floor(50 * 0.8)
    expect(model.publicIpBudget).toBe(10)
    expect(model.activeAccounts).toBe(2)
    expect(poolCapacityPer15m()).toBe(80) // 2 * 40
    expect(healthyAccountCount()).toBe(2)
    expect(defaultKeyLimitPer15m()).toBe(26) // floor(80 / 3)
  })
})

describe('per-IP account fairness', () => {
  test('public IP allowance is a fixed 10 per window regardless of account count', async () => {
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    for (const ip of ['a', 'b', 'c', 'd']) {
      for (let n = 0; n < 10; n++) await searchXStatuses('q', 'latest', undefined, 20, ip)
      await expect(searchXStatuses('q', 'latest', undefined, 20, ip)).rejects.toMatchObject({ status: 429 })
    }
    expect(fetchSearchTweets).toHaveBeenCalledTimes(40)
    await searchXStatuses('q', 'latest', undefined, 20, 'e')
    expect(fetchSearchTweets).toHaveBeenCalledTimes(41)
  })

  test('per-IP allowance is charged once per search, even when a failover retries upstream', async () => {
    fetchSearchTweets.mockRejectedValueOnce(new AuthenticationError('bad')).mockResolvedValue({ tweets: [] })
    // First call: auth failure disables one account and retries on the other (2 upstream calls, 1 IP charge).
    await searchXStatuses('q', 'latest', undefined, 20, 'a')
    for (let n = 0; n < 9; n++) await searchXStatuses('q', 'latest', undefined, 20, 'a')
    await expect(searchXStatuses('q', 'latest', undefined, 20, 'a')).rejects.toMatchObject({ status: 429 })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(11)
  })

  test('post and user searches share one IP allowance', async () => {
    resetXSessions([sessions[0]!])
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    for (let n = 0; n < 10; n++) await searchXStatuses('q', 'latest', undefined, 20, 'a')
    await expect(searchXUsers('q', undefined, 20, 'a')).rejects.toMatchObject({ status: 429 })
    expect(fetchSearchProfiles).not.toHaveBeenCalled()
  })
})

describe('API-key allowance', () => {
  test('a key gets its own quota, separate from public IP limits', async () => {
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
    const caller = { kind: 'key' as const, id: 'k1', limit: 3 }
    for (let n = 0; n < 3; n++) await searchXStatuses('q', 'latest', undefined, 20, caller)
    await expect(searchXStatuses('q', 'latest', undefined, 20, caller)).rejects.toMatchObject({ status: 429 })
    // A public caller is unaffected by the key's exhausted quota.
    await searchXStatuses('q', 'latest', undefined, 20, 'fresh-ip')
    expect(fetchSearchTweets).toHaveBeenCalledTimes(4)
  })
})

describe('dynamic public pool', () => {
  const WINDOW_START = new Date('2026-09-07T12:00:00Z').getTime()
  const publicBurst = async (ips: string[]) => {
    for (const ip of ips) for (let n = 0; n < 10; n++) await searchXStatuses('q', 'latest', undefined, 20, ip)
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(WINDOW_START)
    fetchSearchTweets.mockResolvedValue({ tweets: [] })
  })

  test('an active key reservation caps what the public can draw from the 80-call pool', async () => {
    const { record } = await createApiKey('friend', 70)
    await touchApiKey(record)
    resetPool()
    await publicBurst(['a']) // public cap = 80 − 70 = 10
    await expect(searchXStatuses('q', 'latest', undefined, 20, 'b')).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/Public search capacity/) })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(10)
    // The friend is untouched by the public exhaustion.
    await searchXStatuses('q', 'latest', undefined, 20, { kind: 'key', id: record.id, limit: 70 })
    expect(fetchSearchTweets).toHaveBeenCalledTimes(11)
  })

  test('rejected public requests are refunded, so capacity released later is usable', async () => {
    const { record } = await createApiKey('friend', 70)
    await touchApiKey(record)
    resetPool()
    await publicBurst(['a'])
    for (let n = 0; n < 5; n++) await expect(searchXStatuses('q', 'latest', undefined, 20, 'b')).rejects.toMatchObject({ status: 429 })
    // 14 minutes in with the friend never having used the window: reservation decays to ceil(70/15) = 5 → public cap 75.
    vi.setSystemTime(WINDOW_START + 14 * 60_000)
    resetPool()
    await publicBurst(['b', 'c', 'd', 'e', 'f', 'g']) // 10 + 60 = 70 ≤ 75
    expect(fetchSearchTweets).toHaveBeenCalledTimes(70)
  })

  test('an idle key releases its whole allowance to the public', async () => {
    const { record } = await createApiKey('sleeper', 70)
    await touchApiKey(record, WINDOW_START - 3 * 3_600_000)
    resetPool()
    await publicBurst(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) // full 80
    expect(fetchSearchTweets).toHaveBeenCalledTimes(80)
  })
})
