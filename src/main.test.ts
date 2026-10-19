import { afterEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => {
  let release!: () => void
  const motionReady = new Promise<void>(resolve => { release = resolve })
  return { motionReady, release, setupMotion: vi.fn(), capture: vi.fn(), setupMenu: vi.fn() }
})
vi.mock('./motion', async () => {
  await state.motionReady
  return { setupMotion: state.setupMotion }
})
vi.mock('./posthog', () => ({ captureLandingEvent: state.capture }))
vi.mock('@vercel/analytics', () => ({ inject: vi.fn() }))
vi.mock('./chrome-setup', () => ({ setupMobileMenu: state.setupMenu, setupTheme: vi.fn(), setupLinkPrefetch: vi.fn() }))

afterEach(() => vi.unstubAllGlobals())

test('conversion and menu controls work before optional motion finishes loading', async () => {
  const listeners = new Map<string, (event: Event) => void>()
  const form = { addEventListener: (name: string, listener: (event: Event) => void) => listeners.set(name, listener) }
  const input = { value: 'https://x.com/ada/status/123' }
  const app = {
    firstElementChild: {},
    querySelector: (selector: string) => selector === '[data-convert-form]' ? form : selector === '[data-convert-input]' ? input : null,
    querySelectorAll: () => [],
  }
  const open = vi.fn()
  vi.stubGlobal('document', { querySelector: () => app })
  vi.stubGlobal('window', { location: { hostname: 'mdfromx.com' }, open })
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  try {
    await import('./main')
    expect(state.setupMotion).not.toHaveBeenCalled()
    expect(state.setupMenu).toHaveBeenCalledWith(app)
    const submit = new Event('submit', { cancelable: true })
    listeners.get('submit')!(submit)
    expect(submit.defaultPrevented).toBe(true)
    expect(open).toHaveBeenCalledWith('/ada/status/123?thread=full', '_blank', 'noopener,noreferrer')
    expect(state.capture).toHaveBeenCalledWith('conversion_requested')
  } finally {
    state.release()
    await state.motionReady
  }
})
