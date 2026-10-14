import { afterEach, expect, test, vi } from 'vitest'
import { whenUseful } from './deferred'

afterEach(() => vi.unstubAllGlobals())

/** A window that records listeners, so the test can fire them by name. */
function fakeDom(readyState: string) {
  const listeners = new Map<string, (event: Event) => void>()
  const win = {
    addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', { readyState, visibilityState: 'visible' })
  return {
    listeners,
    remaining: () => [...listeners.keys()],
    fire: (name: string) => listeners.get(name)?.(new Event(name)),
  }
}

test('analytics waits for load and idle instead of loading with the page', async () => {
  const dom = fakeDom('loading')
  const load = vi.fn().mockResolvedValue(undefined)
  whenUseful(load)
  expect(load).not.toHaveBeenCalled()
  dom.fire('load')
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
})

test('first user intent loads it at once and only once', () => {
  const dom = fakeDom('loading')
  const load = vi.fn().mockResolvedValue(undefined)
  whenUseful(load)
  dom.fire('pointerdown')
  dom.fire('scroll')
  expect(load).toHaveBeenCalledOnce()
  // Every intent listener is gone; the one-shot `load` listener is the
  // browser's to remove, and `run` is idempotent if it does fire.
  expect(dom.remaining()).toEqual(['load'])
})

test('a page that goes hidden before load still records the visit', () => {
  const dom = fakeDom('loading')
  const load = vi.fn().mockResolvedValue(undefined)
  whenUseful(load)
  expect(load).not.toHaveBeenCalled()
  vi.stubGlobal('document', { readyState: 'loading', visibilityState: 'hidden' })
  dom.fire('visibilitychange')
  expect(load).toHaveBeenCalledOnce()
})

test('a failed optional bundle never becomes an unhandled rejection', async () => {
  fakeDom('loading')
  whenUseful(() => Promise.reject(new Error('blocked')))
  await new Promise(resolve => setTimeout(resolve, 10))
})