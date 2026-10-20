import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const motion = vi.hoisted(() => ({ from: vi.fn(), to: vi.fn(), fromTo: vi.fn(), toArray: vi.fn(), create: vi.fn(), reduced: false }))
vi.mock('gsap', () => ({ gsap: {
  registerPlugin: vi.fn(), from: motion.from, to: motion.to, fromTo: motion.fromTo,
  utils: { toArray: motion.toArray },
  matchMedia: () => ({ add: (query: string, callback: () => void) => {
    if (!motion.reduced && query === '(prefers-reduced-motion: no-preference)') callback()
  } }),
} }))
vi.mock('gsap/ScrollTrigger', () => ({ ScrollTrigger: { create: motion.create, refresh: vi.fn() } }))
import { setupMotion } from './motion'

beforeEach(() => { vi.clearAllMocks(); motion.reduced = false })
afterEach(() => vi.unstubAllGlobals())

test('late motion leaves visible text and panes readable and arms only upcoming panes', () => {
  vi.stubGlobal('window', { innerHeight: 800 })
  const scrub = { textContent: 'Visible text', innerHTML: 'Visible text', getBoundingClientRect: () => ({ top: 100 }) }
  const visible = { dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top: 400 }) }
  const upcoming = { dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top: 1000 }) }
  motion.toArray.mockImplementation((selector: string) => selector === '[data-stream-view]' ? [visible, upcoming] : [])
  const root = { querySelector: (selector: string) => selector === '[data-scrub-text]' ? scrub : null }
  setupMotion(root as unknown as HTMLElement)
  expect(scrub.innerHTML).toBe('Visible text')
  expect(visible.dataset.stream).toBeUndefined()
  expect(upcoming.dataset.stream).toBe('armed')
  expect(motion.create).toHaveBeenCalledOnce()
  const { trigger, onEnter } = motion.create.mock.calls[0][0]
  expect(trigger).toBe(upcoming)
  onEnter()
  expect(upcoming.dataset.stream).toBe('play')
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

test.each([false, true])('the closing horizon only moves inside the motion gate, by transform, with reduced=%s', reduced => {
  vi.stubGlobal('window', { innerHeight: 800 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  motion.reduced = reduced
  motion.toArray.mockReturnValue([])
  const sky = {}
  const closing = { querySelector: () => sky }
  const root = { querySelector: (selector: string) => selector === '.orbit-band-closing' ? closing : null }
  setupMotion(root as unknown as HTMLElement)
  expect(motion.fromTo).toHaveBeenCalledTimes(reduced ? 0 : 1)
  expect(motion.from).not.toHaveBeenCalled()
  if (!reduced) {
    const [target, fromVars, { scrollTrigger, ...toVars }] = motion.fromTo.mock.calls[0]
    expect(target).toBe(sky)
    expect(Object.keys(fromVars)).toEqual(['yPercent'])
    expect(toVars).toEqual({ yPercent: 0, ease: 'none' })
    expect(scrollTrigger).toMatchObject({ trigger: closing, scrub: expect.anything() })
  }
})

test('the closing name is typed only when it is still below the fold, and only once it arrives', () => {
  vi.stubGlobal('window', { innerHeight: 800 })
  motion.toArray.mockReturnValue([])
  for (const top of [100, 1000]) {
    motion.create.mockClear()
    const mark = { dataset: {} as Record<string, string>, getBoundingClientRect: () => ({ top }) }
    const root = { querySelector: (selector: string) => selector === '.host-mark' ? mark : null }
    setupMotion(root as unknown as HTMLElement)
    if (top < 800) {
      expect(mark.dataset.type).toBeUndefined()
      expect(motion.create).not.toHaveBeenCalled()
      continue
    }
    expect(mark.dataset.type).toBe('armed')
    const { trigger, once, onEnter } = motion.create.mock.calls[0][0]
    expect([trigger, once]).toEqual([mark, true])
    onEnter()
    expect(mark.dataset.type).toBe('play')
  }
})

test('only the x.com pane gets the markup scroll-by, as decoration, before its lines print', () => {
  vi.stubGlobal('window', { innerHeight: 800 })
  const made: { className: string; textContent: string; attrs: Record<string, string>; children: unknown[] }[] = []
  vi.stubGlobal('document', { createElement: () => {
    const el = { className: '', textContent: '', attrs: {} as Record<string, string>, children: [] as unknown[],
      setAttribute(name: string, value: string) { el.attrs[name] = value },
      append(child: unknown) { el.children.push(child) },
      addEventListener: vi.fn() }
    made.push(el)
    return el
  } })
  const pane = (rain: boolean) => ({
    dataset: (rain ? { rain: '' } : {}) as Record<string, string>,
    style: { setProperty: vi.fn() },
    parentElement: { append: vi.fn() },
    getBoundingClientRect: () => ({ top: 1000 }),
  })
  const xcom = pane(true)
  const md = pane(false)
  motion.toArray.mockImplementation((selector: string) => selector === '[data-stream-view]' ? [xcom, md] : [])
  setupMotion({ querySelector: () => null } as unknown as HTMLElement)
  for (const call of motion.create.mock.calls) call[0].onEnter()
  expect(md.parentElement.append).not.toHaveBeenCalled()
  expect(xcom.parentElement.append).toHaveBeenCalledOnce()
  const layer = made.find(el => el.className === 'markup-rain')!
  expect(layer.attrs['aria-hidden']).toBe('true')
  expect((layer.children[0] as { textContent: string }).textContent).toMatch(/^<div class="css-/)
  expect(xcom.style.setProperty).toHaveBeenCalledWith('--start', expect.stringMatching(/ms$/))
  expect([xcom.dataset.stream, md.dataset.stream]).toEqual(['play', 'play'])
})
