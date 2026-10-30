import { describe, expect, test } from 'vitest'
import { Scraper, SearchMode } from '@the-convocation/twitter-scraper'
import { renderThreadMarkdown } from './markdown.js'
import { tweetToFx } from './xsearch.js'

// Long posts (over 280 characters) carry their full text in `note_tweet`.
// `legacy.full_text` holds only the first part. The patched SearchTimeline
// parser must read the note text, for the post and for a quoted post.
const LONG = `${'Long post body. '.repeat(20)}This is the end of the long post.`
const LONG_QUOTE = `${'Quoted body. '.repeat(25)}This is the end of the quoted post.`
const cut = (text: string) => `${text.slice(0, 270)}…`

const user = (id: string, handle: string) => ({
  rest_id: id,
  core: { screen_name: handle, name: handle },
  legacy: { screen_name: handle, name: handle },
})

const legacy = (id: string, userId: string, fullText: string) => ({
  id_str: id, user_id_str: userId, conversation_id_str: id, full_text: fullText,
  created_at: 'Thu Oct 29 18:22:24 +0000 2026',
  entities: { hashtags: [], symbols: [], urls: [], user_mentions: [] },
  favorite_count: 1, retweet_count: 0, reply_count: 0, bookmark_count: 0,
})

const note = (text: string) => ({ note_tweet: { note_tweet_results: { result: { text } } } })

// The raw SearchTimeline shape X returns: one long post that quotes another long post,
// and one short post with no note_tweet.
const searchTimeline = {
  data: { search_by_raw_query: { search_timeline: { timeline: { instructions: [{
    type: 'TimelineAddEntries',
    entries: [
      { entryId: 'tweet-1', content: { itemContent: { tweetDisplayType: 'Tweet', tweet_results: { result: {
        rest_id: '1', core: { user_results: { result: user('7', 'ada') } },
        legacy: legacy('1', '7', cut(LONG)), ...note(LONG),
        quoted_status_result: { result: {
          rest_id: '2', core: { user_results: { result: user('8', 'bob') } },
          legacy: legacy('2', '8', cut(LONG_QUOTE)), ...note(LONG_QUOTE),
        } },
      } } } } },
      { entryId: 'tweet-3', content: { itemContent: { tweetDisplayType: 'Tweet', tweet_results: { result: {
        rest_id: '3', core: { user_results: { result: user('7', 'ada') } },
        legacy: legacy('3', '7', 'A short post.'),
      } } } } },
    ],
  }] } } } },
}

async function search() {
  const scraper = new Scraper({
    fetch: async () => new Response(JSON.stringify(searchTimeline), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  await scraper.setCookies([
    'auth_token=token; Domain=.x.com; Path=/; Secure; HttpOnly',
    'ct0=csrf; Domain=.x.com; Path=/; Secure',
  ])
  return scraper.fetchSearchTweets('from:ada', 20, SearchMode.Latest)
}

describe('SearchTimeline long posts', () => {
  test('use the full note_tweet text for the post and the quoted post', async () => {
    const { tweets } = await search()
    const [long, short] = tweets.map(tweetToFx)

    expect(long.text).toBe(LONG)
    expect(long.raw_text?.text).toBe(LONG)
    expect(long.quote?.text).toBe(LONG_QUOTE)
    expect(short.text).toBe('A short post.')

    const markdown = renderThreadMarkdown([long], { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/ada/status/1' })
    expect(markdown).toContain('This is the end of the long post.')
    expect(markdown).not.toContain('…')
  })
})
