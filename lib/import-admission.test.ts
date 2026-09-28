import { expect, test } from 'vitest'
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
