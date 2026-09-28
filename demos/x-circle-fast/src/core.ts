/**
 * Interaction extraction and ranking, shared by the server (which turns raw
 * posts into interactions before streaming them) and the browser (which ranks
 * them as they arrive). The rules follow X Circle's published method:
 * reply 3, quote 2.5, mention 1.5, repost 1, halving every 30 days, and the
 * two directions combined as (√given + √received)².
 */

export type Kind = 'reply' | 'quote' | 'mention' | 'repost'
export type Direction = 'out' | 'in'

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
  /** Unix seconds. */
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

/** The subset of an FxTwitter / x.md post object this module reads. */
export interface RawUser {
  screen_name?: string
  name?: string
  avatar_url?: string | null
  protected?: boolean
}

export interface RawPost {
  id?: string
  type?: string
  text?: string
  created_timestamp?: number
  author?: RawUser
  reposted_by?: RawUser | null
  replying_to?: { screen_name?: string } | null
  replying_to_status?: string[] | string | null
  quote?: { author?: RawUser } | null
  raw_text?: {
    display_text_range?: number[]
    facets?: { type?: string; original?: string; indices?: number[] }[]
  }
  replies?: number
}

export const WEIGHTS: Record<Kind, number> = { reply: 3, quote: 2.5, mention: 1.5, repost: 1 }
export const HALF_LIFE_DAYS = 30

const lower = (value: string): string => value.toLowerCase()
const HANDLE = /^[A-Za-z0-9_]{1,15}$/

export function cleanHandle(input: string): string | null {
  let value = input.trim()
  const url = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(value)
  if (url) value = url[1]
  value = value.replace(/^@+/, '')
  return HANDLE.test(value) ? value : null
}

/** Profile photos are served small; the 400px variant keeps the PNG sharp. */
export function largeAvatar(url: string | null | undefined): string | null {
  if (!url || !/^https:\/\/pbs\.twimg\.com\//.test(url)) return null
  return url.replace(/_(normal|bigger|mini|200x200)(\.\w+)$/, '_400x400$2')
}

export function toPerson(user: RawUser | null | undefined): Person | null {
  const handle = user?.screen_name?.trim()
  if (!handle) return null
  return { handle, name: user?.name?.trim() || handle, avatar: largeAvatar(user?.avatar_url) }
}

const bare = (handle: string): Person => ({ handle, name: handle, avatar: null })

function isReply(post: RawPost): boolean {
  if (post.replying_to?.screen_name) return true
  const status = post.replying_to_status
  return Array.isArray(status) ? status.length > 0 : Boolean(status)
}

/**
 * The handles X puts in front of a reply (`@a @b actual text`). Without facets
 * this is the only way to tell the reply chain from a mention in the body.
 */
export function replyChain(text: string): string[] {
  const match = /^(?:\s*@[A-Za-z0-9_]{1,15})+/.exec(text)
  return match ? [...match[0].matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((m) => m[1]) : []
}

/** Mentions in the body, excluding the reply chain X prepends to every answer. */
export function bodyMentions(post: RawPost): string[] {
  const facets = post.raw_text?.facets
  if (facets) {
    const start = post.raw_text?.display_text_range?.[0] ?? 0
    return facets
      .filter((facet) => facet.type === 'mention' && facet.original && (facet.indices?.[0] ?? 0) >= start)
      .map((facet) => (facet.original as string).replace(/^@/, ''))
  }
  let text = post.text ?? ''
  if (isReply(post)) text = text.replace(/^(?:\s*@[A-Za-z0-9_]{1,15})+/, '')
  return [...text.matchAll(/(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})\b/g)].map((m) => m[1])
}

/** Direct parent author of a reply, from the structured field or the chain's first handle. */
function repliedTo(post: RawPost): string | null {
  if (post.replying_to?.screen_name) return post.replying_to.screen_name
  if (!isReply(post)) return null
  return replyChain(post.text ?? '')[0] ?? null
}

/** De-duplicates interactions exactly as X Circle does: one per post, person, kind and direction. */
export class Collector {
  readonly items: Interaction[] = []
  private readonly seen = new Set<string>()
  private readonly self: string

  constructor(self: string) {
    this.self = lower(self)
  }

  add(tweetId: string, other: Person | null, direction: Direction, kind: Kind, at: number): Interaction | null {
    if (!other || lower(other.handle) === this.self) return null
    const key = `${tweetId}:${lower(other.handle)}:${kind}:${direction}`
    if (this.seen.has(key)) return null
    this.seen.add(key)
    const item: Interaction = { tweetId, other, direction, kind, at }
    this.items.push(item)
    return item
  }
}

/** What the account gave: its replies, quotes, reposts and body mentions. */
export function ownPostInteractions(post: RawPost, self: string, collector: Collector): Interaction[] {
  const out: Interaction[] = []
  const push = (item: Interaction | null) => { if (item) out.push(item) }
  const me = lower(self)
  const id = post.id
  const at = post.created_timestamp ?? 0
  const author = toPerson(post.author)
  if (!id || !author) return out
  if (post.reposted_by && lower(post.reposted_by.screen_name ?? '') === me) {
    push(collector.add(id, author, 'out', 'repost', at))
    return out
  }
  if (lower(author.handle) !== me) return out
  const parent = repliedTo(post)
  if (parent) push(collector.add(id, bare(parent), 'out', 'reply', at))
  push(collector.add(id, toPerson(post.quote?.author), 'out', 'quote', at))
  for (const handle of bodyMentions(post)) {
    if (parent && lower(handle) === lower(parent)) continue
    push(collector.add(id, bare(handle), 'out', 'mention', at))
  }
  return out
}

/** What the account got: someone else replying to, quoting or mentioning it. */
export function incomingInteraction(post: RawPost, self: string, collector: Collector): Interaction | null {
  const me = lower(self)
  if (post.reposted_by || !post.id) return null
  const author = toPerson(post.author)
  if (!author || lower(author.handle) === me) return null
  const at = post.created_timestamp ?? 0
  if (lower(repliedTo(post) ?? '') === me) return collector.add(post.id, author, 'in', 'reply', at)
  if (lower(post.quote?.author?.screen_name ?? '') === me) return collector.add(post.id, author, 'in', 'quote', at)
  if (bodyMentions(post).some((handle) => lower(handle) === me)) return collector.add(post.id, author, 'in', 'mention', at)
  return null
}

const decay = (at: number, now: number): number => Math.pow(0.5, Math.max(0, (now - at) / 86400) / HALF_LIFE_DAYS)

export function rank(interactions: Iterable<Interaction>, now = Date.now() / 1000): Member[] {
  interface Tally { profile: Person; given: number; received: number; replies: number; mentions: number; quotes: number; reposts: number; fromYou: number; fromThem: number }
  const people = new Map<string, Tally>()
  for (const item of interactions) {
    const key = lower(item.other.handle)
    let tally = people.get(key)
    if (!tally) {
      tally = { profile: { ...item.other }, given: 0, received: 0, replies: 0, mentions: 0, quotes: 0, reposts: 0, fromYou: 0, fromThem: 0 }
      people.set(key, tally)
    }
    if (!tally.profile.avatar && item.other.avatar) tally.profile = { ...item.other }
    const value = WEIGHTS[item.kind] * decay(item.at, now)
    if (item.direction === 'out') { tally.given += value; tally.fromYou += 1 } else { tally.received += value; tally.fromThem += 1 }
    switch (item.kind) {
      case 'reply': tally.replies += 1; break
      case 'mention': tally.mentions += 1; break
      case 'quote': tally.quotes += 1; break
      case 'repost': tally.reposts += 1; break
      default: { const never: never = item.kind; throw new Error(`unknown kind ${String(never)}`) }
    }
  }
  return [...people.values()]
    .map((t) => ({
      ...t.profile,
      score: t.given + t.received + 2 * Math.sqrt(t.given * t.received),
      replies: t.replies,
      mentions: t.mentions,
      quotes: t.quotes,
      reposts: t.reposts,
      fromYou: t.fromYou,
      fromThem: t.fromThem,
    }))
    .filter((member) => member.score > 0)
    .sort((a, b) => b.score - a.score || a.handle.localeCompare(b.handle))
}
