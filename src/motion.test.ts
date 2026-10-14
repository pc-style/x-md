import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const motion = vi.hoisted(() => ({ from: vi.fn(), to: vi.fn(), toArray: vi.fn() }))
vi.mock('gsap', () => ({ gsap: {
  registerPlugin: vi.fn(), from: motion.from, to: motion.to,
  utils: { toArray: motion.toArray },
  matchMedia: () => ({ add: (query: string, callback: () => void) => {
    if (query === '(prefers-reduced-motion: no-preference)') callback()
  } }),
} }))
vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: { create: vi.fn() } }))
import { setupMotion } from './motion'

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

test('late motion leaves visible text and cards readable and animates upcoming cards', () => {
  vi.stubGlobal('window', { innerHeight: 800 })
  const scrub = { textContent: 'Visible text', innerHTML: 'Visible text', getBoundingClientRect: () => ({ top: 100 }) }
  const visible = { getBoundingClientRect: () => ({ top: 400 }) }
  const upcoming = { getBoundingClientRect: () => ({ top: 1000 }) }
  motion.toArray.mockImplementation((selector: string) => selector === '[data-rise-card]' ? [visible, upcoming] : [])
  const root = { querySelector: (selector: string) => selector === '[data-scrub-text]' ? scrub : null }
  setupMotion(root as unknown as HTMLElement)
  expect(scrub.innerHTML).toBe('Visible text')
  expect(motion.from).toHaveBeenCalledOnce()
  expect(motion.from.mock.calls[0][0]).toBe(upcoming)
})

test('word reveals preserve HTML-looking text as text instead of parsing it', () => {
  vi.stubGlobal('window', { innerHeight: 800 })
  vi.stubGlobal('document', { createElement: () => ({ className: '', textContent: '' }) })
  const replaceChildren = vi.fn()
  const scrub = { textContent: '<img src=x onerror=alert(1)> & text', replaceChildren, getBoundingClientRect: () => ({ top: 1000 }) }
  motion.toArray.mockReturnValue([])
  const root = { querySelector: (selector: string) => selector === '[data-scrub-text]' ? scrub : null }
  setupMotion(root as unknown as HTMLElement)
  expect(replaceChildren).toHaveBeenCalledOnce()
  const nodes = replaceChildren.mock.calls[0] as (string | { className: string; textContent: string })[]
  expect(nodes.map(node => typeof node === 'string' ? node : node.textContent).join('')).toBe(scrub.textContent)
  expect(nodes.filter(node => typeof node !== 'string').every(node => node.className === 'reveal-word')).toBe(true)
})
