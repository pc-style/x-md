import { describe, expect, it } from 'vitest'
import { bodyMentions, cleanHandle, Collector, incomingInteraction, largeAvatar, ownPostInteractions, rank, replyChain, type Interaction, type RawPost } from './core.ts'
import { layout, DEFAULT_STYLE } from './draw.ts'
import { remaining } from './harvest.ts'

const NOW = 1_790_000_000
const day = 86400

describe('cleanHandle', () => {
  it('accepts handles, @handles and profile URLs', () => {
    expect(cleanHandle(' @paulg ')).toBe('paulg')
    expect(cleanHandle('https://x.com/levelsio/status/1')).toBe('levelsio')
    expect(cleanHandle('twitter.com/@jack')).toBe('jack')
    expect(cleanHandle('not a handle')).toBeNull()
    expect(cleanHandle('sixteen_chars_xx')).toBeNull()
  })
})

describe('largeAvatar', () => {
  it('upgrades X photo sizes and rejects other hosts', () => {
    expect(largeAvatar('https://pbs.twimg.com/profile_images/1/a_normal.jpg')).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.jpg')
    expect(largeAvatar('https://pbs.twimg.com/profile_images/1/a_200x200.jpg')).toBe('https://pbs.twimg.com/profile_images/1/a_400x400.jpg')
    expect(largeAvatar('https://evil.example/a.jpg')).toBeNull()
  })
})

describe('mentions', () => {
  it('skips the reply chain using facets', () => {
    const post: RawPost = {
      text: '@bob @carol hi @dave',
      raw_text: { display_text_range: [12, 20], facets: [
        { type: 'mention', original: 'bob', indices: [0, 4] },
        { type: 'mention', original: 'carol', indices: [5, 11] },
        { type: 'mention', original: 'dave', indices: [15, 20] },
      ] },
    }
    expect(bodyMentions(post)).toEqual(['dave'])
  })

  it('skips the reply chain from text when a search result has no facets', () => {
    expect(replyChain('@bob @carol hi @dave')).toEqual(['bob', 'carol'])
    expect(bodyMentions({ text: '@bob @carol hi @dave', replying_to_status: ['1'] })).toEqual(['dave'])
    expect(bodyMentions({ text: '@bob hi @dave and me@example.com' })).toEqual(['bob', 'dave'])
  })
})

describe('ownPostInteractions', () => {
  it('turns replies, quotes, mentions and reposts into outgoing interactions', () => {
    const c = new Collector('me')
    const reply = ownPostInteractions({ id: '1', created_timestamp: NOW, author: { screen_name: 'me' }, replying_to: { screen_name: 'bob' }, text: '@bob ok @carol', raw_text: { display_text_range: [5, 14], facets: [{ type: 'mention', original: 'bob', indices: [0, 4] }, { type: 'mention', original: 'carol', indices: [8, 14] }] } }, 'me', c)
    expect(reply.map((i) => [i.other.handle, i.kind, i.direction])).toEqual([['bob', 'reply', 'out'], ['carol', 'mention', 'out']])
    const quote = ownPostInteractions({ id: '2', created_timestamp: NOW, author: { screen_name: 'Me' }, quote: { author: { screen_name: 'dave', name: 'Dave', avatar_url: 'https://pbs.twimg.com/profile_images/9/d_normal.png' } } }, 'me', c)
    expect(quote).toHaveLength(1)
    expect(quote[0]).toMatchObject({ kind: 'quote', other: { handle: 'dave', avatar: 'https://pbs.twimg.com/profile_images/9/d_400x400.png' } })
    const repost = ownPostInteractions({ id: '3', created_timestamp: NOW, author: { screen_name: 'erin' }, reposted_by: { screen_name: 'me' } }, 'me', c)
    expect(repost[0]).toMatchObject({ kind: 'repost', other: { handle: 'erin' } })
    expect(ownPostInteractions({ id: '4', author: { screen_name: 'someone' } }, 'me', c)).toEqual([])
  })

  it('never links the account to itself and de-duplicates', () => {
    const c = new Collector('me')
    const post: RawPost = { id: '1', created_timestamp: NOW, author: { screen_name: 'me' }, replying_to: { screen_name: 'me' } }
    expect(ownPostInteractions(post, 'me', c)).toEqual([])
    const again: RawPost = { id: '5', created_timestamp: NOW, author: { screen_name: 'me' }, replying_to: { screen_name: 'bob' } }
    expect(ownPostInteractions(again, 'me', c)).toHaveLength(1)
    expect(ownPostInteractions(again, 'me', c)).toHaveLength(0)
  })
})

describe('incomingInteraction', () => {
  it('classifies full posts by structure', () => {
    const c = new Collector('me')
    expect(incomingInteraction({ id: '1', author: { screen_name: 'bob' }, replying_to: { screen_name: 'me' } }, 'me', c)?.kind).toBe('reply')
    expect(incomingInteraction({ id: '2', author: { screen_name: 'bob' }, quote: { author: { screen_name: 'ME' } } }, 'me', c)?.kind).toBe('quote')
    expect(incomingInteraction({ id: '3', author: { screen_name: 'bob' }, text: 'hey @me' }, 'me', c)?.kind).toBe('mention')
    expect(incomingInteraction({ id: '4', author: { screen_name: 'me' }, text: '@me' }, 'me', c)).toBeNull()
    expect(incomingInteraction({ id: '5', author: { screen_name: 'bob' }, text: 'nothing' }, 'me', c)).toBeNull()
  })

  it('classifies slim search results from the reply chain', () => {
    const c = new Collector('me')
    expect(incomingInteraction({ id: '1', author: { screen_name: 'bob' }, text: '@me @carol nice', replying_to_status: ['9'] }, 'me', c)?.kind).toBe('reply')
    expect(incomingInteraction({ id: '2', author: { screen_name: 'bob' }, text: '@carol @me nice', replying_to_status: ['9'] }, 'me', c)).toBeNull()
    expect(incomingInteraction({ id: '3', author: { screen_name: 'bob' }, text: '@carol see @me', replying_to_status: ['9'] }, 'me', c)?.kind).toBe('mention')
  })
})

describe('rank', () => {
  const item = (handle: string, kind: Interaction['kind'], direction: Interaction['direction'], age = 0): Interaction =>
    ({ tweetId: `${handle}${kind}${direction}${age}`, other: { handle, name: handle, avatar: null }, kind, direction, at: NOW - age * day })

  it('weights by kind and halves every 30 days', () => {
    const [a] = rank([item('a', 'reply', 'out')], NOW)
    expect(a.score).toBeCloseTo(3)
    const [old] = rank([item('a', 'reply', 'out', 30)], NOW)
    expect(old.score).toBeCloseTo(1.5)
    expect(rank([item('q', 'quote', 'out')], NOW)[0].score).toBeCloseTo(2.5)
    expect(rank([item('m', 'mention', 'in')], NOW)[0].score).toBeCloseTo(1.5)
    expect(rank([item('r', 'repost', 'out')], NOW)[0].score).toBeCloseTo(1)
  })

  it('doubles an even two-way exchange and ranks it above one-way', () => {
    const ranked = rank([item('both', 'reply', 'out'), item('both', 'reply', 'in'), item('one', 'reply', 'out'), item('one', 'reply', 'out', 0.0001)], NOW)
    expect(ranked[0].handle).toBe('both')
    expect(ranked[0].score).toBeCloseTo(12)
    expect(ranked[0]).toMatchObject({ fromYou: 1, fromThem: 1, replies: 2 })
    expect(ranked[1].score).toBeCloseTo(6, 3)
  })

  it('keeps the photo from whichever interaction had one', () => {
    const withPhoto: Interaction = { ...item('a', 'quote', 'out'), other: { handle: 'A', name: 'A', avatar: 'https://pbs.twimg.com/x.jpg' } }
    expect(rank([item('a', 'reply', 'out'), withPhoto], NOW)[0].avatar).toBe('https://pbs.twimg.com/x.jpg')
  })
})

describe('layout', () => {
  it('places every member inside the square, largest first', () => {
    const members = Array.from({ length: 50 }, (_, i) => ({ handle: `u${i}`, name: '', avatar: null, score: 50 - i, replies: 0, mentions: 0, quotes: 0, reposts: 0, fromYou: 0, fromThem: 0 }))
    const { nodes } = layout(members, DEFAULT_STYLE)
    expect(nodes).toHaveLength(50)
    for (const n of nodes) {
      expect(n.x - n.d / 2).toBeGreaterThanOrEqual(0)
      expect(n.x + n.d / 2).toBeLessThanOrEqual(1200)
    }
    expect(nodes[0].d).toBeGreaterThan(nodes[49].d)
  })
})

describe('remaining', () => {
  it('reads one policy from a RateLimit header', () => {
    expect(remaining('"api-ip";r=599;t=55, "search-key";r=30;t=55, "account-key";r=48;t=175', 'account-key')).toBe(48)
    expect(remaining('"api-ip";r=599;t=55', 'account-key')).toBeNull()
    expect(remaining(null, 'account-key')).toBeNull()
  })
})
