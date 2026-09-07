import { afterEach, describe, expect, test, vi } from 'vitest'
import { firecrawlHitToPost, searchFirecrawlStatuses } from './firecrawl.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('firecrawlHitToPost', () => {
  test('maps status and article URLs, strips markdown headings from snippets', () => {
    expect(firecrawlHitToPost({
      url: 'https://x.com/dshukertjr/status/2030630110697513427',
      title: 'Tyler Shukert on X: "Supabase provides ..."',
      description: '# heading\nSupabase provides backend  features',
    })).toEqual({
      id: '2030630110697513427',
      url: 'https://x.com/dshukertjr/status/2030630110697513427',
      text: 'Supabase provides backend features',
      author: { name: 'Tyler Shukert', screen_name: 'dshukertjr', url: 'https://x.com/dshukertjr' },
    })
    expect(firecrawlHitToPost({ url: 'https://twitter.com/supabase/article/2086106572233781315', title: 'Developer Update | Supabase (@supabase) on X', description: 'Evals' }))
      .toMatchObject({ id: '2086106572233781315', url: 'https://x.com/supabase/article/2086106572233781315', author: { screen_name: 'supabase' } })
  })

  test('drops non-post pages, empty snippets, and falls back to handle when the title is generic', () => {
    expect(firecrawlHitToPost({ url: 'https://x.com/supabase', description: 'bio' })).toBeUndefined()
    expect(firecrawlHitToPost({ url: 'https://x.com/supabase/with_replies', description: 'x' })).toBeUndefined()
    expect(firecrawlHitToPost({ url: 'https://x.com/supabase/highlights', description: 'x' })).toBeUndefined()
    expect(firecrawlHitToPost({ url: 'https://evil.com/x.com/a/status/1', description: 'x' })).toBeUndefined()
    expect(firecrawlHitToPost({ url: 'https://x.com/a/status/1', description: '# only heading' })).toBeUndefined()
    expect(firecrawlHitToPost({ url: 'https://x.com/i/status/1', title: 'Tosin on X', description: '7 hours ago · hi there Log in or sign up' }))
      .toEqual({ id: '1', url: 'https://x.com/i/status/1', text: 'hi there', author: { name: 'Tosin' } })
  })
})

describe('searchFirecrawlStatuses', () => {
  test('throws 503 when unconfigured', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', '')
    await expect(searchFirecrawlStatuses('q', 'latest', 5)).rejects.toMatchObject({ status: 503, code: 'firecrawl_disabled' })
  })

  test('requests x.com-only web results, applies recency for latest, filters and dedupes', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { web: [
        { url: 'https://x.com/supabase', description: 'profile' },
        { url: 'https://x.com/a/status/1', title: 'A on X', description: 'one' },
        { url: 'https://x.com/a/status/1?s=20', title: 'A on X', description: 'dupe' },
        { url: 'https://x.com/b/status/2', title: 'B on X', description: 'two' },
        { url: 'https://x.com/c/status/3', title: 'C on X', description: 'three' },
      ] },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const posts = await searchFirecrawlStatuses('supabase', 'latest', 2)
    expect(posts.map((p) => p.id)).toEqual(['1', '2'])
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).toMatchObject({ query: 'supabase', includeDomains: ['x.com'], tbs: 'qdr:w', sources: ['web'] })
    expect(body.limit).toBe(10)
  })

  test('omits the recency filter for top and maps upstream failures to 503', async () => {
    vi.stubEnv('FIRECRAWL_API_KEY', 'fc-test')
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, error: 'quota' }), { status: 402 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchFirecrawlStatuses('supabase', 'top', 5)).rejects.toMatchObject({ status: 503, code: 'firecrawl_error', message: 'quota' })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tbs).toBeUndefined()
  })
})
