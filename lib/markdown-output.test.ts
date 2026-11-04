import { describe, expect, test } from 'vitest'
import { renderThreadMarkdown } from './markdown.js'
import type { FxTweet } from './fxtwitter.js'

const posts: FxTweet[] = [{
  id: '1',
  text: 'Root post',
  created_at: 'today',
  likes: 12,
  author: { name: 'Root', screen_name: 'root' },
  quote: { id: '9', text: 'Quoted', author: { name: 'Quote', screen_name: 'quote' } },
  media: { videos: [{
    type: 'video', url: 'https://video/high.mp4', thumbnail_url: 'https://img/thumb.jpg',
    duration_ms: 1200, width: 1920, height: 1080, bitrate: 2000,
    variants: [{ url: 'https://video/high.mp4', content_type: 'video/mp4', bitrate: 2000 }, { url: 'https://video/low.mp4', content_type: 'video/mp4', bitrate: 500 }],
  }] },
}, {
  id: '2', text: 'Reply', author: { name: 'Root', screen_name: 'root' },
}]

describe('markdown output', () => {
  test('compact is the concise default shape while full retains metadata', () => {
    const compact = renderThreadMarkdown(posts, { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: true })
    const full = renderThreadMarkdown(posts, { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: false })
    expect(compact).not.toContain('Stats:')
    expect(full).toContain('Stats: 12 likes')
    expect(full).toContain('Date: today')
  })

  test('renders source URLs for every item and quote plus complete video metadata', () => {
    const output = renderThreadMarkdown(posts, { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: true })
    expect(output).toContain('https://x.com/root/status/1')
    expect(output).toContain('https://x.com/root/status/2')
    expect(output).toContain('https://x.com/quote/status/9')
    expect(output).toContain('[video](https://video/high.mp4)')
    expect(output).toContain('duration: 1200ms · 1920×1080 · 2000bps')
    expect(output).toContain('https://video/low.mp4')
  })

  test('renders typed relation labels in compact and full output', () => {
    const related = posts.map((post, index) => ({ ...post, context: index === 0 ? 'post' as const : 'reply' as const }))
    const compact = renderThreadMarkdown(related, { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: true })
    const full = renderThreadMarkdown(related, { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: false })
    expect(compact).toContain('## Post · 1/2')
    expect(compact).toContain('## Reply · 2/2')
    expect(full).toContain('## Post · 1/2')
  })

  test('retains the post relation in single-post full and Obsidian output', () => {
    const single = [{ ...posts[0], context: 'post' as const }]
    const full = renderThreadMarkdown(single, { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: false })
    const obsidian = renderThreadMarkdown(single, { format: 'obsidian', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1' })
    expect(full).toContain('## Post · 1/1')
    expect(obsidian).toContain('## Post · 1/1')
  })

  test('does not attribute an unidentified reply to the requested post URL', () => {
    const output = renderThreadMarkdown([
      { ...posts[0], context: 'post' },
      { text: 'Identity missing', context: 'reply' },
    ], {
      format: 'markdown',
      userinfo: 'off',
      canonicalUrl: 'https://x.com/root/status/1',
      compact: true,
    })

    expect(output).toContain('Source: Unavailable (post identity missing)')
    expect(output.match(/https:\/\/x\.com\/root\/status\/1/g)).toHaveLength(1)
  })

  test('renders poll choices and results on posts and quotes', () => {
    const poll = {
      choices: [{ label: 'Yes', count: 7814391, percentage: 51.8 }, { label: 'No', count: 7271067, percentage: 48.2 }],
      total_votes: 15085458,
      time_left_en: 'Final results',
    }
    const output = renderThreadMarkdown([{
      id: '1', text: 'Reinstate?', author: { name: 'Root', screen_name: 'root' }, poll,
      quote: { id: '9', text: 'Quoted poll', author: { name: 'Quote', screen_name: 'quote' }, poll: { choices: [{ label: 'Maybe' }] } },
    }], { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: true })
    expect(output).toContain('Poll · 15,085,458 votes · Final results')
    expect(output).toContain('- Yes: 51.8% (7,814,391 votes)')
    expect(output).toContain('- No: 48.2% (7,271,067 votes)')
    expect(output).toContain('> - Maybe\n>\n> Source: https://x.com/quote/status/9')
  })

  test('links an animated GIF to its playable MP4, keeping the thumbnail', () => {
    const output = renderThreadMarkdown([{
      id: '1', text: 'gif', author: { name: 'Root', screen_name: 'root' },
      media: { all: [{ type: 'gif', url: 'https://video.twimg.com/tweet_video/A.mp4', thumbnail_url: 'https://pbs.twimg.com/tweet_video_thumb/A.jpg' }] },
    }], { format: 'markdown', userinfo: 'off', canonicalUrl: 'https://x.com/root/status/1', compact: true })
    expect(output).toContain('[animated_gif](https://video.twimg.com/tweet_video/A.mp4)')
    expect(output).toContain('![animated_gif thumbnail](https://pbs.twimg.com/tweet_video_thumb/A.jpg)')
  })
})
