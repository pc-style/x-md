import { afterEach, expect, test, vi } from 'vitest'
import { formatStars, headerHtml } from './chrome'
import { fetchGitHubStars } from './vite-prerender-plugin'

afterEach(() => vi.unstubAllEnvs())

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

test('reads the star count, sending GITHUB_TOKEN when set', async () => {
  vi.stubEnv('GITHUB_TOKEN', 'test-token')
  const fetchImpl = reply(200, { stargazers_count: 1234 })
  expect(await fetchGitHubStars(fetchImpl)).toBe(1234)
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
  expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-token')
})

test.each([
  ['an error status', reply(403, { message: 'rate limited' })],
  ['an unexpected body', reply(200, { stargazers_count: '1.2k' })],
  ['a network failure', vi.fn(async () => { throw new TypeError('fetch failed') })],
])('gives no count, rather than a guess, on %s', async (_, fetchImpl) => {
  expect(await fetchGitHubStars(fetchImpl as unknown as typeof fetch)).toBeNull()
})

test('the header shows a compact count only when one was read', () => {
  expect([162, 1234, 12_345].map(formatStars)).toEqual(['162', '1.2k', '12.3k'])
  expect(headerHtml({ page: 'landing', stars: 1234 })).toContain('aria-label="GitHub, 1.2k stars"')
  for (const stars of [undefined, null]) {
    const html = headerHtml({ page: 'about', stars })
    expect(html).not.toMatch(/stars/)
    expect(html).toMatch(/<svg[^>]*><path[^>]*\/><\/svg>GitHub<\/a>/)
  }
})
