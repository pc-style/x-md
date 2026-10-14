import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { decodeTimelineCursor, encodeTimelineCursor, snowflakeAt } from './fx-cursor.js'
import { resetFxPool } from './fxtwitter.js'
import { importProfilePosts } from './import.js'
import { importProfilePosts as importOnMain } from './fixtures/import-main.js'

const NOW = Date.UTC(2026, 9, 1, 12)

const HOUR = 3_600_000
const posts = Array.from({ length: 300 }, (_, i) => ({ id: snowflakeAt(NOW - (i + 1) * HOUR).toString(), text: `post ${i}`, created_at: new Date(NOW - (i + 1) * HOUR).toUTCString(), author: { screen_name: 'ada' } }))

/** The real FxTwitter client over a stubbed `fetch`: 300 hourly posts, and a profile that answers in turn from `profile`. */
function stubUpstream(profile: Array<() => Response | Promise<Response>>) {
  let profileCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (/^\/2\/profile\/[^/]+$/.test(url.pathname)) return profile[Math.min(profileCalls++, profile.length - 1)]()
    const below = decodeTimelineCursor(url.searchParams.get('cursor')!)!.sortIndex
    const results = posts.filter((post) => BigInt(post.id) < below).slice(0, 30)
    return Response.json({ code: 200, results, cursor: results.length ? { bottom: encodeTimelineCursor({ issuedAt: 0n, sortIndex: BigInt(results.at(-1)!.id), direction: 2 }) } : undefined })
  }))
}

beforeEach(() => resetFxPool())
afterEach(() => {
  vi.unstubAllGlobals()
  resetFxPool()
})

test('a profile miss and then a throttle fail the import with the throttle and its Retry-After, as on main', async () => {
  const miss = () => Response.json({ code: 404, message: 'NOT_FOUND' }, { status: 404 })
  // The throttle comes back after the miss has been read.
  const throttle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return new Response('slow down', { status: 429, headers: { 'Retry-After': '600' } })
  }
  // Twenty posts fit the first page, so no timeline page lands on the base the
  // throttle cooled and the profile alone decides the error.
  const input = { handle: 'ada', until: new Date(NOW), maxPosts: 20 }

  stubUpstream([miss, throttle])
  const onMain = await importOnMain(input).then(() => undefined, (error: unknown) => error)
  expect(onMain).toMatchObject({ status: 503, code: 'upstream_rate_limited', retryAfter: 600 })

  resetFxPool()
  stubUpstream([miss, throttle])
  const onHead = await importProfilePosts(input).then(() => undefined, (error: unknown) => error)
  expect(onHead).toMatchObject({ status: 503, code: (onMain as { code: string }).code, retryAfter: (onMain as { retryAfter: number }).retryAfter })
})
