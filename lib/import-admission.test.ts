import { expect, test, vi } from 'vitest'
import { withImportSlot } from './import-admission.js'

test('bounds concurrent walks, rejects overload, and releases after failure', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const first = withImportSlot(() => pending)
  const second = withImportSlot(() => pending)
  await expect(withImportSlot(async () => 3)).rejects.toMatchObject({ code: 'import_busy', retryAfter: 5 })
  release()
  await Promise.all([first, second])
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
