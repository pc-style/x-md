/** Interaction scoring from X Circle: reply 3, quote 2.5, mention 1.5, repost 1, half-life 30 days. */

export type Kind = 'reply' | 'quote' | 'mention' | 'repost'
export type Direction = 'in' | 'out'

export interface Person {
  handle: string
  name: string
  avatar: string | null
}

export interface Interaction {
  tweetId: string
  other: Person
  direction: Direction
  kind: Kind
  at: number
}

export interface Member extends Person {
  score: number
  replies: number
  mentions: number
  quotes: number
  reposts: number
  fromYou: number
  fromThem: number
}

export interface TweetAuthor {
  screen_name?: string
  name?: string
  avatar_url?: string
}

export interface Tweet {
  id?: string
  text?: string
  created_at?: string
  created_timestamp?: number
  author?: TweetAuthor | null
  replying_to?: { screen_name?: string } | string[] | null
  replying_to_status?: string[] | null
  quote?: { author?: TweetAuthor | null } | null
  reposted_by?: TweetAuthor | null
  raw_text?: {
    display_text_range?: number[]
    facets?: Array<{ type?: string; indices?: number[]; original?: string }>
  } | null
}

const WEIGHT: Record<Kind, number> = { reply: 3, quote: 2.5, mention: 1.5, repost: 1 }

export const WINDOW_DAYS = 120

export function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function decay(at: number, now: number): number {
  return 0.5 ** (Math.max(0, (now - at) / 86400) / 30)
}

export function normalizeAvatar(url?: string | null): string | null {
  if (!url || !/^https:\/\/pbs\.twimg\.com\//.test(url)) return null
  return url.replace(/_(?:normal|bigger|mini|\d+x\d+)(\.\w+)$/, '_400x400$1')
}

export function personFrom(author?: TweetAuthor | null): Person | null {
  const handle = author?.screen_name?.trim()
  if (!handle) return null
  return { handle, name: author?.name?.trim() || handle, avatar: normalizeAvatar(author?.avatar_url) }
}

export function mergePerson(current: Person | null, next: Person | null): Person | null {
  if (!next) return current
  if (!current) return next
  const nextName = next.name && next.name.toLowerCase() !== next.handle.toLowerCase() ? next.name : null
  const currentName = current.name && current.name.toLowerCase() !== current.handle.toLowerCase() ? current.name : null
  return {
    handle: current.handle,
    name: currentName ?? nextName ?? current.name,
    avatar: current.avatar ?? next.avatar,
  }
}

export function replyHandle(post: Tweet): string | null {
  const reply = post.replying_to
  if (Array.isArray(reply)) return reply[0]?.replace(/^@/, '') || null
  return reply?.screen_name?.replace(/^@/, '') || null
}

export function postTime(post: Tweet): number | null {
  const stamp = post.created_timestamp
  if (typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0) return stamp > 1e12 ? stamp / 1000 : stamp
  if (post.created_at) {
    const parsed = Date.parse(post.created_at)
    if (Number.isFinite(parsed)) return parsed / 1000
  }
  return null
}

/** Mentions in the visible text. A reply chain at the start of an answer is not a mention. */
export function mentionHandles(post: Tweet): string[] {
  const raw = post.raw_text
  if (raw && Array.isArray(raw.facets)) {
    const start = raw.display_text_range?.[0] ?? 0
    return raw.facets
      .filter((facet) => facet.type === 'mention' && facet.original && (facet.indices?.[0] ?? 0) >= start)
      .map((facet) => facet.original!.replace(/^@/, ''))
  }
  const isReply = replyHandle(post) != null || (post.replying_to_status?.length ?? 0) > 0
  return handlesIn(visibleBody(post.text ?? '', isReply))
}

function handlesIn(text: string): string[] {
  return [...text.matchAll(/@([A-Za-z0-9_]{1,15})\b/g)].map((match) => match[1]!)
}

function visibleBody(text: string, stripReplyPrefix: boolean): string {
  if (!stripReplyPrefix) return text
  return text.replace(/^(?:@[A-Za-z0-9_]{1,15}[ \t]*)+/, '')
}

function directReplyTo(text: string, owner: string): boolean {
  const match = text.match(/^@([A-Za-z0-9_]{1,15})\b/)
  return !!match && same(match[1]!, owner)
}

export function ingestOwn(post: Tweet, owner: string, cutoff: number, push: (interaction: Interaction) => void): boolean {
  const at = postTime(post)
  if (at == null || at < cutoff || !post.id) return false
  const author = personFrom(post.author)
  if (post.reposted_by?.screen_name && same(post.reposted_by.screen_name, owner)) {
    if (author && !same(author.handle, owner)) push({ tweetId: post.id, other: author, direction: 'out', kind: 'repost', at })
    return true
  }
  const reposted = /^RT @([A-Za-z0-9_]{1,15})\b/.exec(post.text ?? '')
  if (reposted && author && same(author.handle, owner) && !same(reposted[1]!, owner)) {
    push({ tweetId: post.id, other: { handle: reposted[1]!, name: reposted[1]!, avatar: null }, direction: 'out', kind: 'repost', at })
    return true
  }
  if (!author || !same(author.handle, owner)) return true
  const replyTo = replyHandle(post)
  if (replyTo && !same(replyTo, owner)) {
    push({ tweetId: post.id, other: { handle: replyTo, name: replyTo, avatar: null }, direction: 'out', kind: 'reply', at })
  }
  const quoted = personFrom(post.quote?.author)
  if (quoted && !same(quoted.handle, owner)) push({ tweetId: post.id, other: quoted, direction: 'out', kind: 'quote', at })
  for (const handle of mentionHandles(post)) {
    if (same(handle, owner)) continue
    if (replyTo && same(handle, replyTo)) continue
    push({ tweetId: post.id, other: { handle, name: handle, avatar: null }, direction: 'out', kind: 'mention', at })
  }
  return true
}

export function ingestIncoming(post: Tweet, owner: string, cutoff: number, push: (interaction: Interaction) => void): boolean {
  if (post.reposted_by?.screen_name || !post.id) return false
  const at = postTime(post)
  if (at == null || at < cutoff) return false
  const author = personFrom(post.author)
  if (!author || same(author.handle, owner)) return false
  const replyTo = replyHandle(post)
  const text = post.text ?? ''
  let kind: Kind | null = null
  if (replyTo && same(replyTo, owner)) kind = 'reply'
  else if (post.quote?.author?.screen_name && same(post.quote.author.screen_name, owner)) kind = 'quote'
  else if (!replyTo && directReplyTo(text, owner)) kind = 'reply'
  else if (incomingMention(post, owner)) kind = 'mention'
  if (!kind) return false
  push({ tweetId: post.id, other: author, direction: 'in', kind, at })
  return true
}

function incomingMention(post: Tweet, owner: string): boolean {
  if (post.raw_text?.facets) return mentionHandles(post).some((handle) => same(handle, owner))
  return handlesIn(visibleBody(post.text ?? '', true)).some((handle) => same(handle, owner))
}

export function rank(interactions: Interaction[], now = Date.now() / 1000): Member[] {
  const rows = new Map<string, {
    profile: Person
    out: number
    inn: number
    replies: number
    mentions: number
    quotes: number
    reposts: number
    fromYou: number
    fromThem: number
  }>()
  for (const interaction of interactions) {
    const key = interaction.other.handle.toLowerCase()
    if (rows.has(key) === false) {
      rows.set(key, { profile: { ...interaction.other }, out: 0, inn: 0, replies: 0, mentions: 0, quotes: 0, reposts: 0, fromYou: 0, fromThem: 0 })
    }
    const row = rows.get(key)!
    if (!row.profile.avatar && interaction.other.avatar) row.profile = { ...interaction.other }
    else if (row.profile.name.toLowerCase() === row.profile.handle.toLowerCase() && interaction.other.name.toLowerCase() !== interaction.other.handle.toLowerCase()) {
      row.profile = { ...row.profile, name: interaction.other.name }
    }
    const weight = WEIGHT[interaction.kind] * decay(interaction.at, now)
    if (interaction.direction === 'out') {
      row.out += weight
      row.fromYou += 1
    } else {
      row.inn += weight
      row.fromThem += 1
    }
    if (interaction.kind === 'reply') row.replies += 1
    else if (interaction.kind === 'mention') row.mentions += 1
    else if (interaction.kind === 'quote') row.quotes += 1
    else row.reposts += 1
  }
  return [...rows.values()].map((row) => ({
    ...row.profile,
    score: row.out + row.inn + 2 * Math.sqrt(row.out * row.inn),
    replies: row.replies,
    mentions: row.mentions,
    quotes: row.quotes,
    reposts: row.reposts,
    fromYou: row.fromYou,
    fromThem: row.fromThem,
  })).filter((member) => member.score > 0).sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
}
