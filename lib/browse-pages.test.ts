import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { browse } from './browse.js'
import { resetMemoryCache } from './cache.js'
import { resetFxPool } from './fxtwitter.js'

const posts = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), text: `post ${i + 1}`, author: { screen_name: 'ada' } }))
const users = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), screen_name: `user${i + 1}` }))

beforeEach(() => {
  vi.stubEnv('CACHE_DISABLED', '0')
  vi.stubEnv('CACHE_PERSIST', '0')
  resetMemoryCache()
  resetFxPool()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetMemoryCache(); resetFxPool() })

test.each(['profile', 'followers'] as const)('overlapping %s pages share pending origin work and retain distinct output', async resource => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let lists = 0
  let identities = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const path = new URL(String(input)).pathname
    if (path === '/2/profile/ada') { identities++; await gate; return Response.json({ user: { screen_name: 'ada' } }) }
    lists++
    await gate
    return Response.json({ results: resource === 'profile' ? posts : users, cursor: { bottom: 'next' } })
  }))
  const pending = Array.from({ length: 6 }, (_, index) => browse({ resource, handle: 'ada', page: index + 1, limit: 2 }))
  try {
    await vi.waitFor(() => expect(lists).toBeGreaterThan(0))
  } finally { release() }
  const results = await Promise.all(pending)
  expect(lists).toBe(1)
  expect(identities).toBe(resource === 'profile' ? 1 : 0)
  results.forEach((result, index) => {
    expect((result.posts ?? result.users)?.map(item => item.id)).toEqual([String(index * 2 + 1), String(index * 2 + 2)])
    expect(result.nextCursor).toBe(`${resource === 'profile' ? 'profile:' : ''}@${index * 2 + 2}`)
  })
})

test('a later page fetches a new snapshot after earlier work settles', async () => {
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    requests++
    return Response.json({ results: users.map(user => ({ ...user, name: `snapshot ${requests}` })), cursor: { bottom: 'next' } })
  }))
  const first = await browse({ resource: 'followers', handle: 'ada', page: 1, limit: 2 })
  const next = await browse({ resource: 'followers', handle: 'ada', page: 2, limit: 2 })
  expect(first.users?.[0].name).toBe('snapshot 1')
  expect(next.users?.[0].name).toBe('snapshot 2')
  expect(requests).toBe(2)
})

test('explicit bypasses do not join another request’s pending page', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async () => { requests++; await gate; return Response.json({ results: users }) }))
  const pending = [browse({ resource: 'followers', handle: 'ada', limit: 2 }), browse({ resource: 'followers', handle: 'ada', limit: 2, nocache: true })]
  try { await vi.waitFor(() => expect(requests).toBe(2)) } finally { release() }
  const results = await Promise.all(pending)
  expect(results.map(result => result.cache)).toEqual(['miss', 'bypass'])
})

test('different upstream counts and relations remain separate', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string) => { paths.push(String(input)); await gate; return Response.json({ results: users }) }))
  const pending = Promise.all([
    browse({ resource: 'followers', handle: 'ada', limit: 2 }),
    browse({ resource: 'followers', handle: 'ada', limit: 3 }),
    browse({ resource: 'following', handle: 'ada', limit: 2 }),
  ])
  try { await vi.waitFor(() => expect(paths).toHaveLength(3)) } finally { release() }
  await pending
  expect(paths).toHaveLength(3)
  expect(paths.some(path => path.includes('/following?'))).toBe(true)
  expect(paths.some(path => path.includes('count=3'))).toBe(true)
})

test('a shared upstream failure clears pending work for a later retry', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let requests = 0
  vi.stubGlobal('fetch', vi.fn(async () => {
    requests++
    await gate
    return requests === 1 ? new Response('{}', { status: 503 }) : Response.json({ results: users })
  }))
  const settled = Promise.allSettled([
    browse({ resource: 'followers', handle: 'ada', page: 1, limit: 2 }),
    browse({ resource: 'followers', handle: 'ada', page: 2, limit: 2 }),
  ])
  try { await vi.waitFor(() => expect(requests).toBe(1)) } finally { release() }
  expect((await settled).map(result => result.status)).toEqual(['rejected', 'rejected'])
  const recovered = await browse({ resource: 'followers', handle: 'ada', page: 2, limit: 2 })
  expect(recovered.users?.map(user => user.id)).toEqual(['3', '4'])
  expect(requests).toBe(2)
})

test('disabled caching leaves overlapping origin requests independent', async () => {
  vi.stubEnv('CACHE_DISABLED', '1')
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetchMock = vi.fn(async () => { await gate; return Response.json({ results: users }) })
  vi.stubGlobal('fetch', fetchMock)
  const pending = Promise.all([
    browse({ resource: 'followers', handle: 'ada', page: 1, limit: 2 }),
    browse({ resource: 'followers', handle: 'ada', page: 2, limit: 2 }),
  ])
  try { await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2)) } finally { release() }
  await pending
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
