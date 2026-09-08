import { describe, expect, test, vi } from 'vitest'
import { convertRewrites } from '@vercel/routing-utils'
import config from '../vercel.json'
import { convertTweet, markdownResponse, parseStatusUrl, STATUS_PATH } from './converter'

vi.mock('./cache.js', () => ({
  buildCacheKey: vi.fn(() => 'status-test'),
  withCache: vi.fn(async (_key: string, _nocache: boolean, fn: () => Promise<unknown>) => ({
    value: await fn(), status: 'miss',
  })),
  cacheControlHeader: vi.fn(() => 'no-store'),
  vercelCacheControlHeader: vi.fn(() => 'no-store'),
}))

vi.mock('./tweet-fetch.js', () => ({
  fetchPosts: vi.fn(async () => ({
    tweets: [{
      id: '1998744066419302490',
      text: 'Save your favourite bezier easing curves.',
      author: { name: 'Motion', screen_name: 'motiondotdev' },
      media: { videos: [{ type: 'video', url: 'https://video.twimg.com/test.mp4' }] },
    }],
    source: 'fxtwitter',
  })),
}))

const canonicalUrl = 'https://x.com/motiondotdev/status/1998744066419302490'
const routes = convertRewrites(config.rewrites)

describe('status permalink routing', () => {
  test.each(['', '/', '/video/1?s=46', '/video/1/?s=46', '/photo/2', '/photo/2/'])('serves %s through production, local, and API URL paths', async (suffix) => {
    const url = new URL(canonicalUrl + suffix)
    const route = routes.find((route) => 'src' in route && new RegExp(route.src).test(url.pathname))
    expect(route).toBeDefined()
    if (!route || !('src' in route)) throw new Error('Missing status rewrite')
    const destination = new URL(url.pathname.replace(new RegExp(route.src), route.dest!), url.origin)
    expect(destination.pathname).toBe('/api/convert')
    expect(destination.searchParams.get('handle')).toBe('motiondotdev')
    expect(destination.searchParams.get('id')).toBe('1998744066419302490')
    expect(STATUS_PATH.exec(url.pathname)?.slice(1)).toEqual(['motiondotdev', '1998744066419302490'])
    expect(parseStatusUrl(url.href)).toEqual({
      handle: 'motiondotdev', id: '1998744066419302490', canonicalUrl,
    })

    const result = await convertTweet({ url: url.href })
    expect(result.canonicalUrl).toBe(canonicalUrl)
    expect(markdownResponse(result).body).toContain('[video](https://video.twimg.com/test.mp4)')
    expect(JSON.parse(markdownResponse(result, true).body).posts[0].media.videos[0].url).toBe(
      'https://video.twimg.com/test.mp4',
    )
  })

  test.each(['/video/0', '/video/-1', '/video/nope', '/video/1/extra', '/other/1'])('rejects invalid media suffix %s', (suffix) => {
    const url = new URL(canonicalUrl + suffix)
    expect(STATUS_PATH.test(url.pathname)).toBe(false)
    expect(() => parseStatusUrl(url.href)).toThrow()
    // The trailing catch-all sends every unmatched path to the negotiated 404,
    // so these must miss every converter route rather than every route.
    const matched = routes.filter((route) => 'src' in route && new RegExp(route.src).test(url.pathname))
    expect(matched.some((route) => route.dest?.startsWith('/api/convert'))).toBe(false)
    expect(matched.every((route) => route.dest?.startsWith('/api/notfound'))).toBe(true)
  })
})
