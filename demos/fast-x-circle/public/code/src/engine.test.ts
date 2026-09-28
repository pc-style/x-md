import { describe, expect, test } from 'vitest'
import { collectCircle, type CircleEvent } from './engine'

const NOW = Date.now()

function stream(lines: unknown[]): Response {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', { status: 200 })
}

describe('collectCircle', () => {
  test('streams own posts and incoming mentions into one ranked circle', async () => {
    const events: CircleEvent[] = []
    const avatar = 'https://pbs.twimg.com/profile_images/ada_normal.jpg'
    await collectCircle('ada', {
      now: NOW,
      fresh: true,
      portrait: async () => null,
      onEvent: (event) => events.push(event),
      fetch: async (input) => {
        const url = String(input)
        expect(url).not.toContain('Bearer')
        if (url.includes('/posts?')) {
          expect(url).toContain('format=ndjson')
          expect(url).toContain('refresh=true')
          return stream([
            { post: { id: '1', created_timestamp: Math.floor(NOW / 1000), author: { screen_name: 'ada', name: 'Ada Lovelace', avatar_url: avatar }, replying_to: { screen_name: 'bob' }, text: '@bob hi' } },
            { meta: { count: 1 }, profile: { screen_name: 'ada', name: 'Ada Lovelace', avatar_url: avatar } },
          ])
        }
        if (url.includes('/search')) {
          return Response.json({
            source: 'xsearch',
            posts: [{ id: '2', created_timestamp: Math.floor(NOW / 1000), author: { screen_name: 'bob', name: 'Bob' }, text: '@ada hi back' }],
          })
        }
        return new Response('missing', { status: 500 })
      },
    })
    const done = events.find((event) => event.type === 'done')
    expect(done?.type).toBe('done')
    if (done?.type !== 'done') return
    expect(done.snapshot.owner.name).toBe('Ada Lovelace')
    expect(done.snapshot.owner.avatar).toContain('_400x400')
    expect(done.snapshot.members[0]?.handle).toBe('bob')
    expect(done.snapshot.members[0]?.fromYou).toBe(1)
    expect(done.snapshot.members[0]?.fromThem).toBe(1)
    expect(done.snapshot.ownPosts).toBe(1)
    expect(done.snapshot.mentions).toBe(1)
    expect(done.snapshot.mentionsRead).toBe(true)
    expect(done.timing.firstProgressMs).toBeGreaterThanOrEqual(0)
    expect(events.some((event) => event.type === 'circle' && event.partial)).toBe(true)
  })
})
