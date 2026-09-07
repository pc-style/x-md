import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./cache.js', () => ({
  buildCacheKey: vi.fn(() => 'browse-test'),
  cacheControlHeader: vi.fn(() => 'public, max-age=300'),
  vercelCacheControlHeader: vi.fn(() => 'public, s-maxage=300'),
  withCache: vi.fn(async (_key: string, _nocache: boolean, fn: () => Promise<unknown>) => ({ value: await fn(), status: 'miss' })),
}))

vi.mock('./firecrawl.js', () => ({
  firecrawlSearchConfigured: vi.fn(() => true),
  searchFirecrawlStatuses: vi.fn(),
}))

vi.mock('./ratelimit.js', () => ({
  rateLimit: vi.fn(async () => ({ allowed: true, limit: 30, remaining: 29, retryAfter: 60 })),
}))

vi.mock('./xsearch.js', () => ({
  xsearchConfigured: vi.fn(() => false),
  searchXStatuses: vi.fn(),
  searchXUsers: vi.fn(),
}))

vi.mock('./fxtwitter.js', () => ({
  fetchFxProfile: vi.fn(),
  fetchFxProfileStatuses: vi.fn(),
  fetchFxConnections: vi.fn(),
  searchFxStatuses: vi.fn(),
}))

import { browse, browseResponse, isOriginalPost, resetSearchBreaker } from './browse.js'
import { buildCacheKey } from './cache.js'
import { ConvertError } from './errors.js'
import { firecrawlSearchConfigured, searchFirecrawlStatuses } from './firecrawl.js'
import { rateLimit } from './ratelimit.js'
import { searchXStatuses, searchXUsers, xsearchConfigured } from './xsearch.js'
import { fetchFxConnections, fetchFxProfile, fetchFxProfileStatuses, searchFxStatuses } from './fxtwitter.js'

const post = { id: '1', text: 'hello', url: 'https://x.com/ada/status/1', author: { screen_name: 'ada' } }

beforeEach(() => {
  vi.clearAllMocks()
  resetSearchBreaker()
})

describe('browse', () => {
  test('filters replies and reposts from a profile and includes source links', async () => {
    vi.mocked(fetchFxProfile).mockResolvedValue({ screen_name: 'ada', name: 'Ada' })
    vi.mocked(fetchFxProfileStatuses).mockResolvedValue({
      results: [post, { ...post, id: '2', replying_to: ['bob'] }, { ...post, id: '3', reposted_by: 'bob' }],
      cursor: { bottom: 'next' },
    })
    const result = await browse({ resource: 'profile', handle: 'ada', nocache: true })
    expect(result.posts).toHaveLength(1)
    expect(result.markdown).toContain('[@ada](https://x.com/ada)')
    expect(result.markdown).toContain('[Source](https://x.com/ada/status/1)')
    expect(result.markdown).toContain('/ada?cursor=next')
    expect(result.markdown).toContain('/ada?page=2')
  })

  test('walks cursors sequentially for page=N', async () => {
    vi.mocked(searchFxStatuses)
      .mockResolvedValueOnce({ results: [], cursor: { bottom: 'page-2' } })
      .mockResolvedValueOnce({ results: [post], cursor: { bottom: 'page-3' } })
    const result = await browse({ resource: 'search', q: 'hello world', page: 2, nocache: true })
    expect(searchFxStatuses).toHaveBeenNthCalledWith(2, 'hello world', 'latest', 'page-2', 20)
    expect(result.markdown).toContain('/search?q=hello+world&feed=latest&cursor=fxtwitter%3Apage-3')
    expect(result.markdown).toContain('/search?q=hello+world&feed=latest&page=3')
  })

  test.each([
    { full: 'false', expected: false },
    { full: 'true', expected: true },
  ])('parses full=$full when building both continuation links', async ({ full, expected }) => {
    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post], cursor: { bottom: 'next' } })
    const result = await browse({ resource: 'search', q: 'x-md', full, limit: 7, page: 3, nocache: true })
    expect(result.markdown.includes('full=true')).toBe(expected)
    expect(result.markdown).toContain('limit=7')
    expect(result.markdown).toContain('cursor=fxtwitter%3Anext')
    expect(result.markdown).toContain('page=4')
  })

  test('dispatches following and caps the local limit', async () => {
    vi.mocked(fetchFxConnections).mockResolvedValue({ results: [{ screen_name: 'bob' }] })
    const result = await browse({ resource: 'following', handle: 'ada', limit: 999, nocache: true })
    expect(fetchFxConnections).toHaveBeenCalledWith('ada', 'following', undefined, 20)
    expect(result.users?.[0]?.screen_name).toBe('bob')
  })

  test('produces structured JSON with response metadata', async () => {
    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post] })
    const result = await browse({ resource: 'search', q: 'x-md', full: true, nocache: true })
    const response = browseResponse(result, true)
    expect(response.headers['Content-Type']).toContain('application/json')
    expect(response.headers).toMatchObject({
      Vary: 'Accept',
      'Cache-Control': 'public, max-age=300',
      'Vercel-CDN-Cache-Control': 'public, s-maxage=300',
    })
    expect(response.headers['X-Source']).toBe('fxtwitter')
    expect(response.headers['X-Result-Count']).toBe('1')
    expect(JSON.parse(response.body)).toMatchObject({ resource: 'search', query: 'x-md' })
    expect(result.markdown).toContain('0 likes')
  })

  test('rejects Obsidian output on browse resources', async () => {
    await expect(browse({ resource: 'profile', handle: 'ada', format: 'obsidian' }))
      .rejects.toBeInstanceOf(ConvertError)
  })

  test('includes output format in the cache identity', async () => {
    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post] })
    await browse({ resource: 'search', q: 'x-md', format: 'json' })
    expect(vi.mocked(buildCacheKey)).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'json', v: 4 }),
    )
  })
})

test('provider filtering identifies replies and reposts', () => {
  expect(isOriginalPost(post)).toBe(true)
  expect(isOriginalPost({ ...post, replying_to_status: ['9'] })).toBe(false)
  expect(isOriginalPost({ ...post, reposted_by: { screen_name: 'bob' } })).toBe(false)
})

describe('search fallback', () => {
  const outage = new ConvertError(503, 'down', 'search_unavailable')

  test('serves Firecrawl snippets as a degraded result when live search is down', async () => {
    vi.mocked(searchFxStatuses).mockRejectedValue(outage)
    vi.mocked(searchFirecrawlStatuses).mockResolvedValue([post])
    const result = await browse({ resource: 'search', q: 'hello', full: true, nocache: true })
    expect(searchFirecrawlStatuses).toHaveBeenCalledWith('hello', 'latest', 20)
    expect(result).toMatchObject({ source: 'firecrawl', degraded: true, posts: [post] })
    expect(result.markdown).toContain('> Live X search is unavailable')
    expect(result.markdown).not.toContain('likes')
    expect(result.markdown).not.toContain('Continue')
    const response = browseResponse(result, false)
    expect(response.headers).toMatchObject({ 'X-Source': 'firecrawl', 'X-Search-Degraded': 'true' })
  })

  test('does not fall back for continuations or when unconfigured', async () => {
    vi.mocked(searchFxStatuses).mockRejectedValue(outage)
    const unavailable = { status: 503, code: 'search_unavailable' }
    await expect(browse({ resource: 'search', q: 'hello', cursor: 'c1', nocache: true })).rejects.toMatchObject(unavailable)
    await expect(browse({ resource: 'search', q: 'hello', page: 2, nocache: true })).rejects.toMatchObject(unavailable)
    vi.mocked(firecrawlSearchConfigured).mockReturnValueOnce(false)
    await expect(browse({ resource: 'search', q: 'hello', nocache: true })).rejects.toMatchObject(unavailable)
    expect(searchFirecrawlStatuses).not.toHaveBeenCalled()
  })

  test('does not fall back on other errors', async () => {
    const other = new ConvertError(502, 'boom', 'fxtwitter_error')
    vi.mocked(searchFxStatuses).mockRejectedValue(other)
    await expect(browse({ resource: 'search', q: 'hello', nocache: true })).rejects.toBe(other)
    expect(searchFirecrawlStatuses).not.toHaveBeenCalled()
  })

  test('live results report the fxtwitter source and no degraded header', async () => {
    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post] })
    const result = await browse({ resource: 'search', q: 'hello', nocache: true })
    const response = browseResponse(result, false)
    expect(response.headers['X-Source']).toBe('fxtwitter')
    expect(response.headers['X-Search-Degraded']).toBeUndefined()
  })
})

describe('search provider chain', () => {
  const outage = new ConvertError(503, 'down', 'search_unavailable')
  const live = { id: '9', text: 'live', url: 'https://x.com/bob/status/9', author: { screen_name: 'bob' } }

  beforeEach(() => vi.mocked(xsearchConfigured).mockReturnValue(true))

  test('uses own accounts when FxTwitter is down and tags the cursor with the source', async () => {
    vi.mocked(searchFxStatuses).mockRejectedValue(outage)
    vi.mocked(searchXStatuses).mockResolvedValue({ results: [live], cursor: { bottom: 'raw-next' } })
    const result = await browse({ resource: 'search', q: 'hello', nocache: true })
    expect(searchXStatuses).toHaveBeenCalledWith('hello', 'latest', undefined, 20, { kind: 'public', ip: undefined })
    expect(result).toMatchObject({ source: 'xsearch', nextCursor: 'xsearch:raw-next' })
    expect(result.degraded).toBeUndefined()
    expect(result.markdown).toContain('cursor=xsearch%3Araw-next')
    expect(searchFirecrawlStatuses).not.toHaveBeenCalled()
    expect(browseResponse(result, false).headers['X-Source']).toBe('xsearch')
  })

  test('skips FxTwitter for a minute after it fails', async () => {
    vi.mocked(searchFxStatuses).mockRejectedValue(outage)
    vi.mocked(searchXStatuses).mockResolvedValue({ results: [live] })
    await browse({ resource: 'search', q: 'a', nocache: true })
    await browse({ resource: 'search', q: 'b', nocache: true })
    expect(searchFxStatuses).toHaveBeenCalledTimes(1)
    expect(searchXStatuses).toHaveBeenCalledTimes(2)
  })

  test('routes tagged cursors to their provider only', async () => {
    vi.mocked(searchXStatuses).mockResolvedValue({ results: [live] })
    await browse({ resource: 'search', q: 'hello', cursor: 'xsearch:abc', nocache: true })
    expect(searchFxStatuses).not.toHaveBeenCalled()
    expect(searchXStatuses).toHaveBeenCalledWith('hello', 'latest', 'abc', 20, { kind: 'public', ip: undefined })

    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post], cursor: { bottom: 'n2' } })
    const legacy = await browse({ resource: 'search', q: 'hello', cursor: 'legacy-cursor', nocache: true })
    expect(searchFxStatuses).toHaveBeenLastCalledWith('hello', 'latest', 'legacy-cursor', 20)
    expect(legacy.nextCursor).toBe('fxtwitter:n2')
  })

  test('falls through to Firecrawl only after every live provider fails, and 503s otherwise', async () => {
    vi.mocked(searchFxStatuses).mockRejectedValue(outage)
    vi.mocked(searchXStatuses).mockRejectedValue(outage)
    vi.mocked(searchFirecrawlStatuses).mockResolvedValue([post])
    const result = await browse({ resource: 'search', q: 'hello', nocache: true })
    expect(result.source).toBe('firecrawl')
    await expect(browse({ resource: 'search', q: 'hello', cursor: 'xsearch:abc', nocache: true })).rejects.toBe(outage)
  })
})

describe('search per-IP limit', () => {
  test('counts only live lookups and rejects with 429 + retryAfter when exceeded', async () => {
    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post] })
    await browse({ resource: 'search', q: 'hello', nocache: true, ip: '1.2.3.4' })
    expect(rateLimit).toHaveBeenCalledWith('search:ip:1.2.3.4', 5, 60)
    vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, limit: 30, remaining: 0, retryAfter: 17 })
    await expect(browse({ resource: 'search', q: 'hello', nocache: true, ip: '1.2.3.4' }))
      .rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 17 })
    expect(searchFxStatuses).toHaveBeenCalledTimes(1)
  })

  test('skips the limiter without an IP and never counts a cache hit', async () => {
    vi.mocked(searchFxStatuses).mockResolvedValue({ results: [post] })
    await browse({ resource: 'search', q: 'hello', nocache: true })
    expect(rateLimit).not.toHaveBeenCalled()
    const { withCache } = await import('./cache.js')
    vi.mocked(withCache).mockResolvedValueOnce({ value: { resource: 'search', markdown: '', page: 1, limit: 20, source: 'fxtwitter' } as never, status: 'hit' })
    await browse({ resource: 'search', q: 'hello', ip: '1.2.3.4' })
    expect(rateLimit).not.toHaveBeenCalled()
  })
})

describe('search modes', () => {
  test.each(['Photos', 'Videos', 'media'])('routes %s to own accounts with a 20-result cap', async (feed) => {
    vi.mocked(xsearchConfigured).mockReturnValue(true)
    vi.mocked(searchXStatuses).mockResolvedValue({ results: Array.from({ length: 30 }, () => post) })
    const result = await browse({ resource: 'search', q: 'hello', feed, limit: 50, nocache: true })
    expect(result.posts).toHaveLength(20)
    expect(searchXStatuses).toHaveBeenCalledWith('hello', feed === 'Videos' ? 'videos' : 'photos', undefined, 20, { kind: 'public', ip: undefined })
    expect(searchFxStatuses).not.toHaveBeenCalled()
    expect(searchFirecrawlStatuses).not.toHaveBeenCalled()
  })

  test('renders users, counts them, and preserves their cursor and feed', async () => {
    vi.mocked(xsearchConfigured).mockReturnValue(true)
    vi.mocked(searchXUsers).mockResolvedValue({ results: [{ name: 'Ada', screen_name: 'ada', followers: 42 }], cursor: { bottom: 'next' } })
    const result = await browse({ resource: 'search', q: 'ada', feed: 'Users', full: true, cursor: 'xsearch:prev', nocache: true })
    expect(searchXUsers).toHaveBeenCalledWith('ada', 'prev', 20, { kind: 'public', ip: undefined })
    expect(result.posts).toBeUndefined()
    expect(result.markdown).toContain('Ada (@ada)')
    expect(result.markdown).toContain('42 followers')
    expect(result.markdown).toContain('feed=users&cursor=xsearch%3Anext')
    expect(browseResponse(result, true).headers['X-Result-Count']).toBe('1')
  })

  test.each(['photos', 'videos', 'users'])('does not degrade %s into unrelated posts', async (feed) => {
    vi.mocked(xsearchConfigured).mockReturnValue(false)
    await expect(browse({ resource: 'search', q: 'hello', feed, nocache: true })).rejects.toMatchObject({ code: 'search_unavailable' })
    expect(searchFirecrawlStatuses).not.toHaveBeenCalled()
  })
})

test('passes the same IP through every page of an account-backed search', async () => {
  vi.mocked(xsearchConfigured).mockReturnValue(true)
  vi.mocked(searchXStatuses).mockResolvedValue({ results: [post], cursor: { bottom: 'next' } })
  await browse({ resource: 'search', q: 'hello', feed: 'photos', page: 2, ip: '1.2.3.4', nocache: true })
  expect(searchXStatuses).toHaveBeenNthCalledWith(1, 'hello', 'photos', undefined, 20, { kind: 'public', ip: '1.2.3.4' })
  expect(searchXStatuses).toHaveBeenNthCalledWith(2, 'hello', 'photos', 'next', 20, { kind: 'public', ip: '1.2.3.4' })
})
