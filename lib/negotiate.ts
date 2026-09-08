/**
 * Accept-header content negotiation (RFC 9110 12.5.1).
 *
 * Substring tests like `accept.includes('text/markdown')` get `q=0` and
 * `text/html, text/markdown;q=0` wrong, so representation choice goes through
 * a real parser: sort by q, break ties by specificity, honour explicit
 * rejection.
 */

export type Repr = 'html' | 'markdown' | 'json' | 'text'

export const MEDIA: Record<Repr, string> = {
  html: 'text/html',
  markdown: 'text/markdown',
  json: 'application/json',
  text: 'text/plain',
}

export const CONTENT_TYPE: Record<Repr, string> = {
  html: 'text/html; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  text: 'text/plain; charset=utf-8',
}

interface Entry {
  type: string
  sub: string
  q: number
}

export function parseAccept(header: string): Entry[] {
  const out: Entry[] = []
  for (const raw of header.split(',')) {
    const parts = raw.trim().split(';')
    const media = parts.shift()?.trim().toLowerCase()
    if (!media) continue
    const [type = '*', sub = '*'] = media.split('/')
    let q = 1
    for (const p of parts) {
      const [key, value] = p.split('=')
      if (key?.trim().toLowerCase() !== 'q') continue
      const parsed = Number.parseFloat(value ?? '')
      if (Number.isFinite(parsed)) q = Math.min(1, Math.max(0, parsed))
    }
    out.push({ type, sub, q })
  }
  return out
}

/** Best q and specificity for one offered media type, or null when unmatched. */
function score(entries: Entry[], media: string): { q: number; spec: number } | null {
  const [type, sub] = media.split('/')
  let best: { q: number; spec: number } | null = null
  for (const entry of entries) {
    let spec: number
    if (entry.type === type && entry.sub === sub) spec = 3
    else if (entry.type === type && entry.sub === '*') spec = 2
    else if (entry.type === '*' && entry.sub === '*') spec = 1
    else continue
    if (!best || spec > best.spec) best = { q: entry.q, spec }
  }
  return best
}

/**
 * Pick a representation from `offers`, or null when the caller accepts none of
 * them (the caller should answer 406). A missing Accept and a bare `*\/*` both
 * mean "no preference", which resolves to `fallback`.
 */
export function selectRepresentation(
  accept: string | null | undefined,
  offers: readonly Repr[],
  fallback: Repr,
): Repr | null {
  if (!accept || !accept.trim()) return fallback
  const entries = parseAccept(accept)
  if (entries.length === 0) return fallback

  let winner: Repr | null = null
  let winning = { q: 0, spec: 0 }
  for (const offer of offers) {
    const match = score(entries, MEDIA[offer])
    if (!match || match.q === 0) continue
    if (match.q > winning.q || (match.q === winning.q && match.spec > winning.spec)) {
      winner = offer
      winning = match
    }
  }
  if (!winner) return null

  // Only a wildcard matched, so the caller expressed no preference between our
  // representations: keep the resource's own default.
  if (winning.spec === 1 && offers.includes(fallback)) {
    const fb = score(entries, MEDIA[fallback])
    if (fb && fb.q > 0) return fallback
  }
  return winner
}

/** RFC 9110 15.5.7 body listing what the resource can produce. */
export function notAcceptableBody(offers: readonly Repr[], accept: string | null | undefined): string {
  return [
    'This resource is available in:',
    ...offers.map((offer) => `- ${MEDIA[offer]}`),
    '',
    `You requested: ${accept || '(none)'}`,
    '',
  ].join('\n')
}
