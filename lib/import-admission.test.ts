import { expect, test, vi } from 'vitest'
import { IMPORT_MAX_ACTIVE, withImportSlot, type ImportOwner } from './import-admission.js'

test('bounds concurrent walks, rejects overload, and releases after failure', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const walks = Array.from({ length: IMPORT_MAX_ACTIVE }, () => withImportSlot(() => pending))
  await expect(withImportSlot(async () => 3)).rejects.toMatchObject({ code: 'import_busy', retryAfter: 5 })
  release()
  await Promise.all(walks)
  await expect(withImportSlot(async () => { throw new Error('failed') })).rejects.toThrow('failed')
  expect(await withImportSlot(async () => 'recovered')).toBe('recovered')
})

test('serializes case-insensitive archive writes and releases the lock', async () => {
  const { withHistoryLock } = await import('./import-admission.js')
  let release!: () => void
  const pending = withHistoryLock('Ada', () => new Promise<void>(resolve => { release = resolve }))
  await expect(withHistoryLock('ada', async () => 1)).rejects.toMatchObject({ code: 'import_busy' })
  expect(await withHistoryLock('bob', async () => 2)).toBe(2)
  release()
  await pending
  expect(await withHistoryLock('ada', async () => 3)).toBe(3)
})

test('a request\'s next walk does not compete with its own released slot', async () => {
  // Shared Redis with one slot held elsewhere; a release lands when its reply does, 20 ms later.
  const active = new Set<string>(['another-instance'])
  vi.stubEnv('KV_REST_API_URL', 'https://kv.example')
  vi.stubEnv('KV_REST_API_TOKEN', 'token')
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    const [[name, ...args]] = JSON.parse(String(init?.body)) as (string | number)[][]
    let result: unknown = 1
    if (name === 'EVAL') {
      result = active.size >= 2 ? 0 : 1
      if (result) active.add(String(args[6]))
    } else if (name === 'ZREM') {
      await new Promise((resolve) => setTimeout(resolve, 20))
      active.delete(String(args[1]))
    }
    return new Response(JSON.stringify([{ result }]))
  }))
  try {
    // A top-up, then the backfill the same request walks next.
    expect(await withImportSlot(async () => 'top-up')).toBe('top-up')
    expect(await withImportSlot(async () => 'backfill')).toBe('backfill')
  } finally {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  }
})

test('one caller cannot hold more than its share, and keyed callers are not starved', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const hold = (owner: ImportOwner) => withImportSlot(() => pending, owner).then(() => 'done', (error: { code?: string }) => error.code)
  const ipA: ImportOwner = { kind: 'ip', id: '203.0.113.1' }
  const ipB: ImportOwner = { kind: 'ip', id: '203.0.113.2' }
  const key: ImportOwner = { kind: 'key', id: 'key_1' }

  // One address opens MAX_ACTIVE walks: it keeps one lease, another address and a keyed caller still get in.
  const fromA = Array.from({ length: IMPORT_MAX_ACTIVE }, () => hold(ipA))
  const fromB = hold(ipB)
  const keyed = hold(key)
  // The anonymous pool is full; a third address waits, the keyed slot stays reserved.
  await expect(withImportSlot(async () => 1, { kind: 'ip', id: '203.0.113.3' })).rejects.toMatchObject({ code: 'import_busy', retryAfter: 5 })
  release()
  expect((await Promise.all(fromA)).sort()).toEqual(['done', ...Array<string>(IMPORT_MAX_ACTIVE - 1).fill('import_busy')])
  expect(await fromB).toBe('done')
  expect(await keyed).toBe('done')

  // MAX_ACTIVE + 1 walks from one address alone cannot deny the keyed caller.
  let again!: () => void
  const blocked = new Promise<void>(resolve => { again = resolve })
  const flood = Array.from({ length: IMPORT_MAX_ACTIVE + 1 }, () => withImportSlot(() => blocked, ipA).catch(() => undefined))
  expect(await withImportSlot(async () => 200, key)).toBe(200)
  again()
  await Promise.all(flood)
})
