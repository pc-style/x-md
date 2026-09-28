import { describe, expect, test } from 'vitest'
import { decay, ingestIncoming, ingestOwn, mentionHandles, normalizeAvatar, rank, type Interaction, type Tweet } from './rank'

const NOW = 1_800_000_000

function tweet(overrides: Tweet): Tweet {
  return { id: '1', created_timestamp: NOW, author: { screen_name: 'ada', name: 'Ada' }, ...overrides }
}

describe('avatars', () => {
  test('profile image sizes are requested at 400 pixels', () => {
    expect(normalizeAvatar('https://pbs.twimg.com/profile_images/1/a_200x200.jpg')).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.jpg')
    expect(normalizeAvatar('https://pbs.twimg.com/profile_images/1/a_normal.png')).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.png')
    expect(normalizeAvatar('https://example.com/a.jpg')).toBeNull()
  })
})

describe('rank', () => {
  test('one reply now is worth 3', () => {
    const [member] = rank([{ tweetId: '1', other: { handle: 'bob', name: 'bob', avatar: null }, direction: 'out', kind: 'reply', at: NOW }], NOW)
    expect(member?.score).toBeCloseTo(3)
    expect(member?.fromYou).toBe(1)
    expect(member?.replies).toBe(1)
  })

  test('even both ways doubles the plain sum', () => {
    const interactions: Interaction[] = [
      { tweetId: '1', other: { handle: 'bob', name: 'Bob', avatar: null }, direction: 'out', kind: 'reply', at: NOW },
      { tweetId: '2', other: { handle: 'bob', name: 'Bob', avatar: null }, direction: 'in', kind: 'reply', at: NOW },
    ]
    const [member] = rank(interactions, NOW)
    expect(member?.score).toBeCloseTo(12)
    expect(member?.fromYou).toBe(1)
    expect(member?.fromThem).toBe(1)
  })

  test('a reply halves after 30 days', () => {
    const at = NOW - 30 * 86400
    expect(decay(at, NOW)).toBeCloseTo(0.5)
    const [member] = rank([{ tweetId: '1', other: { handle: 'bob', name: 'bob', avatar: null }, direction: 'out', kind: 'reply', at }], NOW)
    expect(member?.score).toBeCloseTo(1.5)
  })

  test('sorts by score, then handle', () => {
    const interactions: Interaction[] = [
      { tweetId: '1', other: { handle: 'cara', name: 'cara', avatar: null }, direction: 'out', kind: 'mention', at: NOW },
      { tweetId: '2', other: { handle: 'bob', name: 'bob', avatar: null }, direction: 'out', kind: 'mention', at: NOW },
    ]
    expect(rank(interactions, NOW).map((member) => member.handle)).toEqual(['bob', 'cara'])
  })
})

describe('mentions and directions', () => {
  test('a reply-chain mention before the visible text is ignored', () => {
    const post = tweet({
      text: '@bob hello @cara',
      raw_text: {
        display_text_range: [5, 16],
        facets: [
          { type: 'mention', indices: [0, 4], original: 'bob' },
          { type: 'mention', indices: [11, 16], original: 'cara' },
        ],
      },
    })
    expect(mentionHandles(post)).toEqual(['cara'])
  })

  test('outgoing reply, quote, and body mention are separate', () => {
    const found: Interaction[] = []
    ingestOwn(tweet({
      id: '9',
      replying_to: { screen_name: 'bob' },
      quote: { author: { screen_name: 'quinn', name: 'Quinn' } },
      text: '@bob see @cara',
      raw_text: {
        display_text_range: [5, 14],
        facets: [
          { type: 'mention', indices: [0, 4], original: 'bob' },
          { type: 'mention', indices: [9, 14], original: 'cara' },
        ],
      },
    }), 'ada', NOW - 10, (interaction) => found.push(interaction))
    expect(found.map((interaction) => `${interaction.kind}:${interaction.other.handle}`).sort()).toEqual(['mention:cara', 'quote:quinn', 'reply:bob'])
  })

  test('a repost points outward at the original author', () => {
    const found: Interaction[] = []
    ingestOwn(tweet({
      id: '3',
      author: { screen_name: 'maya', name: 'Maya' },
      reposted_by: { screen_name: 'ada' },
    }), 'ada', NOW - 10, (interaction) => found.push(interaction))
    expect(found).toMatchObject([{ direction: 'out', kind: 'repost', other: { handle: 'maya' } }])
  })

  test('a retweet prefix is an outgoing repost when the repost field is absent', () => {
    const found: Interaction[] = []
    ingestOwn(tweet({ id: '8', text: 'RT @maya: a note' }), 'ada', NOW - 10, (interaction) => found.push(interaction))
    expect(found).toMatchObject([{ direction: 'out', kind: 'repost', other: { handle: 'maya' } }])
  })

  test('a leading @ is an incoming reply and a later @ is a mention', () => {
    const reply: Interaction[] = []
    const mention: Interaction[] = []
    ingestIncoming(tweet({ id: '4', author: { screen_name: 'bob', name: 'Bob' }, text: '@ada hello' }), 'ada', NOW - 10, (interaction) => reply.push(interaction))
    ingestIncoming(tweet({ id: '5', author: { screen_name: 'cara', name: 'Cara' }, text: 'hello @ada' }), 'ada', NOW - 10, (interaction) => mention.push(interaction))
    expect(reply[0]?.kind).toBe('reply')
    expect(mention[0]?.kind).toBe('mention')
  })

  test('someone only in the reply chain is not an incoming mention', () => {
    const found: Interaction[] = []
    const kept = ingestIncoming(tweet({ id: '6', author: { screen_name: 'bob', name: 'Bob' }, text: '@cara @ada hello' }), 'ada', NOW - 10, (interaction) => found.push(interaction))
    expect(kept).toBe(false)
    expect(found).toEqual([])
  })
})
