import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { resetMemoryCache } from './cache.js'
import { convertTweet, type ConvertInput } from './converter.js'
import { fetchPosts } from './tweet-fetch.js'

vi.mock('./tweet-fetch.js', () => ({ fetchPosts: vi.fn() }))

const url = 'https://x.com/example/status/3'
const tweets = [
  { id: '1', text: 'parent', context: 'parent' as const },
  { id: '2', text: 'nearest parent', context: 'parent' as const },
  { id: '3', text: 'requested post', context: 'post' as const },
  { id: '4', text: 'continuation', context: 'thread' as const },
]

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'))
  vi.stubEnv('CACHE_PERSIST', 'false')
  vi.stubEnv('CACHE_DISABLED', 'false')
  vi.stubEnv('CACHE_TTL_SECONDS', '60')
  resetMemoryCache()
  vi.mocked(fetchPosts).mockReset().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    return { tweets, source: 'fxtwitter' }
  })
})

afterEach(() => {
  resetMemoryCache()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function read(input: ConvertInput = {}) {
  const pending = convertTweet({ url, ...input })
  await vi.runAllTimersAsync()
  return pending
}

test('six representations reuse one fresh snapshot without repeating upstream latency', async () => {
  const started = Date.now()
  const variants: ConvertInput[] = [
    {}, { format: 'json' }, { format: 'obsidian' },
    { full: true }, { userinfo: 'all' }, { thread: '2' },
  ]
  const results = []
  for (const variant of variants) results.push(await read(variant))

  expect(Date.now() - started).toBe(500)
  expect(fetchPosts).toHaveBeenCalledTimes(1)
  expect(results.map(result => result.cache)).toEqual(['miss', 'hit', 'hit', 'hit', 'hit', 'hit'])
  expect(new Set(results.map(result => result.fetchedAt)).size).toBe(1)
  expect(results[1].format).toBe('json')
  expect(results[2]).toMatchObject({ format: 'obsidian', compact: false })
  expect(results[3].compact).toBe(false)
  expect(results[5].posts.map(post => post.id)).toEqual(['2', '3'])
  expect(results[5].warnings).toEqual(['Thread truncated to 2 posts.'])
  expect(results[0].posts).toHaveLength(4)
  expect(results[0].warnings).toEqual([])
})

test('rendering a small view first keeps the full snapshot and current canonical URL', async () => {
  const small = await read({ thread: '2' })
  const full = await read({ url: 'https://x.com/EXAMPLE/status/3', full: true })
  expect(fetchPosts).toHaveBeenCalledTimes(1)
  expect(small.posts.map(post => post.id)).toEqual(['2', '3'])
  expect(full.posts).toHaveLength(4)
  expect(full.canonicalUrl).toBe('https://x.com/EXAMPLE/status/3')
  expect(full.posts[2].url).toBe(full.canonicalUrl)
  expect(full.warnings).toEqual([])
})

test('retrieval options stay isolated while nocache does not replace a saved snapshot', async () => {
  const original = await read()
  await read({ thread: 'off' })
  await read({ context: 'thread' })
  await read({ replies: 'off' })
  await read({ replies: 'recent' })
  const fresh = await read({ nocache: true })
  const cached = await read({ format: 'json' })
  expect(fetchPosts).toHaveBeenCalledTimes(6)
  expect(fresh.cache).toBe('bypass')
  expect(fresh.fetchedAt).not.toBe(original.fetchedAt)
  expect(cached.cache).toBe('hit')
  expect(cached.fetchedAt).toBe(original.fetchedAt)
})

test('another representation cannot extend the source snapshot lifetime', async () => {
  const original = await read()
  await vi.advanceTimersByTimeAsync(59_000)
  const json = await read({ format: 'json' })
  expect(json.fetchedAt).toBe(original.fetchedAt)
  await vi.advanceTimersByTimeAsync(1_001)
  const refreshed = await read({ format: 'obsidian' })
  expect(refreshed.cache).toBe('miss')
  expect(refreshed.fetchedAt).not.toBe(original.fetchedAt)
  expect(fetchPosts).toHaveBeenCalledTimes(2)
})

test.each([undefined, '2'])('malformed posts cannot poison a snapshot first requested with thread=%s', async (thread) => {
  vi.useRealTimers()
  // Model an invalid runtime payload without weakening the provider's static type.
  const malformed = JSON.parse('{"id":"4","text":123,"context":"thread"}')
  vi.mocked(fetchPosts).mockResolvedValueOnce({
    tweets: [...tweets.slice(0, 3), malformed], source: 'fxtwitter',
  }).mockResolvedValue({ tweets, source: 'fxtwitter' })

  await expect(convertTweet({ url, thread })).rejects.toThrow()
  const recovered = await convertTweet({ url })
  expect(recovered.cache).toBe('miss')
  expect(recovered.posts).toHaveLength(4)
  expect(recovered.body).toContain('continuation')
  expect(fetchPosts).toHaveBeenCalledTimes(2)
})

test('duplicate author handles cannot hide malformed metadata in a cached snapshot', async () => {
  vi.useRealTimers()
  const malformedAuthor = JSON.parse('{"screen_name":"example","followers":{"toLocaleString":null}}')
  vi.mocked(fetchPosts).mockResolvedValueOnce({
    tweets: tweets.map((tweet, index) => ({
      ...tweet,
      author: index === 0 ? { screen_name: 'example', followers: 10 } : malformedAuthor,
    })),
    source: 'fxtwitter',
  }).mockResolvedValue({ tweets, source: 'fxtwitter' })

  await expect(convertTweet({ url })).rejects.toThrow()
  const recovered = await convertTweet({ url, thread: '2', userinfo: 'all' })
  expect(recovered.cache).toBe('miss')
  expect(recovered.posts.map(post => post.id)).toEqual(['2', '3'])
  expect(fetchPosts).toHaveBeenCalledTimes(2)
})
