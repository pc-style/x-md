import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { fetchContextDevStatus } from './contextdev.js'
import { ConvertError } from './errors.js'

const ORIGINAL_KEY = process.env.CONTEXT_DEV_API_KEY

describe('fetchContextDevStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    process.env.CONTEXT_DEV_API_KEY = 'ctxt_secret_test'
  })

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CONTEXT_DEV_API_KEY
    else process.env.CONTEXT_DEV_API_KEY = ORIGINAL_KEY
    vi.unstubAllGlobals()
  })

  test('scrapes a status URL through Context.dev markdown API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          markdown: '# X\n\n@alice\n\nReal post body\n\n12 likes',
          url: 'https://x.com/alice/status/123',
        }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tweet = await fetchContextDevStatus('alice', '123')

    expect(tweet).toEqual({
      id: '123',
      url: 'https://x.com/alice/status/123',
      text: 'Real post body',
      author: { name: 'alice', screen_name: 'alice', url: 'https://x.com/alice' },
    })

    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]))
    expect(calledUrl.origin + calledUrl.pathname).toBe('https://api.context.dev/v1/web/scrape/markdown')
    expect(calledUrl.searchParams.get('url')).toBe('https://x.com/alice/status/123')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer ctxt_secret_test' }),
    })
  })

  test.each([
    ['short post', 'just setting up my twttr', 'just setting up my twttr'],
    [
      'long multiline post',
      `A long post ${'with actual content '.repeat(40)}\n\n#StillPartOfThePost\n[Read this](https://example.com/article)`,
      `A long post ${'with actual content '.repeat(40).trim()}\n#StillPartOfThePost\n[Read this](https://example.com/article)`,
    ],
    ['leading hashtag', '#StillPartOfThePost', '#StillPartOfThePost'],
    ['link-only post', '[Read this](https://example.com/article)', '[Read this](https://example.com/article)'],
    ['profile-link post', '[NASA](https://x.com/NASA)', '[NASA](https://x.com/NASA)'],
    ['media-only post', '![Photo](https://pbs.twimg.com/media/photo.jpg)', ''],
    [
      'bulleted profile link in content',
      'Intro\n- [@NASA](https://x.com/NASA)\nMore text',
      'Intro\n- [@NASA](https://x.com/NASA)\nMore text',
    ],
  ])('extracts %s without page chrome or replies', async (_label, body, expected) => {
    const login = '[Log in](https://x.com/i/jf/onboarding/web?mode=login&redirect_after_login=%2Fjack%2Fstatus%2F20) [Sign up](https://x.com/i/jf/onboarding/web?mode=signup&redirect_after_login=%2Fjack%2Fstatus%2F20)'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      markdown: [
        '[X](https://x.com/)',
        '## Post', login, '## Post', login,
        '# jack on X: "just setting up my twttr"',
        '## Conversation',
        '- [@jack](https://x.com/jack)',
        '[jack](https://x.com/jack)',
        '[Square](https://x.com/Square)',
        '[@jack](https://x.com/jack)',
        body,
        '[3:50 PM · Mar 21, 2006](https://x.com/jack/status/20)·',
        '[18K](https://x.com/compose/post?in_reply_to=20)',
        '133K', '321K', '24K',
        '- [@other](https://x.com/other)',
        '[Mar 21, 2024](https://x.com/other/status/1770825760162353449)',
        'Hello from the future',
        '## Relevant people',
        'no state is the best state',
      ].join('\n\n'),
    }), { status: 200 })))

    const tweet = await fetchContextDevStatus('jack', '20')

    expect(tweet.text).toBe(expected)
  })

  test.each(['', '·[467.3K Views](https://x.com/lexfridman/status/1770825760162353449)'])(
    'extracts a reply without its parent, including timestamp suffix %s', async (suffix) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        success: true,
        markdown: [
          '# Lex Fridman on X: "@jack Hello from the future"',
          '## Conversation',
          '- [@jack](https://x.com/jack)',
          '[jack](https://x.com/jack)',
          '[Square](https://x.com/Square)',
          '[@jack](https://x.com/jack)',
          '[Mar 21, 2006](https://x.com/jack/status/20)',
          'just setting up my twttr',
          '[18K](https://x.com/compose/post?in_reply_to=20)',
          '133K',
          '- [@lexfridman](https://x.com/lexfridman)',
          '[Lex Fridman](https://x.com/lexfridman)',
          '[@lexfridman](https://x.com/lexfridman)',
          'Hello from the future',
          `[10:52 AM · Mar 21, 2024](https://x.com/lexfridman/status/1770825760162353449)${suffix}`,
          '[131](https://x.com/compose/post?in_reply_to=1770825760162353449)',
          '- [@other](https://x.com/other)',
          'A different reply',
        ].join('\n\n'),
      }), { status: 200 })))

      const tweet = await fetchContextDevStatus('lexfridman', '1770825760162353449')

      expect(tweet.text).toBe('Hello from the future')
    },
  )

  test('is disabled when CONTEXT_DEV_API_KEY is missing', async () => {
    delete process.env.CONTEXT_DEV_API_KEY

    await expect(fetchContextDevStatus('alice', '123')).rejects.toMatchObject({
      status: 502,
      code: 'contextdev_disabled',
    } satisfies Partial<ConvertError>)
  })

  test('wraps Context.dev API errors as ConvertError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
      ),
    )

    await expect(fetchContextDevStatus('alice', '123')).rejects.toMatchObject({
      status: 502,
      code: 'contextdev_error',
      message: 'rate limited',
    } satisfies Partial<ConvertError>)
  })
})
