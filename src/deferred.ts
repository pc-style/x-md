/**
 * Loading policy for the optional bundles the landing page pulls in beside its
 * pre-rendered content.
 *
 * Vercel Web Analytics used to be a static import of `main.ts`, which put its
 * `/_vercel/insights/script.js` request in the window between the document and a
 * painted first screen, competing with the stylesheet, the webfonts and the entry
 * chunks for the six connections a browser opens. Nothing on the page waits for
 * it: the analytics script writes into `window.va`, and a pageview still counts
 * whenever it runs.
 *
 * It now loads at the earliest of three moments:
 *
 *   1. the first real user intent (`pointerdown`, scroll, key press, focus),
 *   2. browser idle time once the page has loaded,
 *   3. the page being hidden, so a visit that would otherwise have recorded
 *      nothing still fires.
 *
 * Docs pages get their own analytics from the Blume build, and the content pages
 * deliberately load none, so this is the landing page's only one.
 */

const IDLE_TIMEOUT_MS = 2000

const INTENTS = [
  'pointerdown',
  'keydown',
  'touchstart',
  'wheel',
  'scroll',
  'focusin',
] as const

function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS })
  else setTimeout(callback, 200)
}

/**
 * Runs `load` once, at the first moment it is worth doing: user intent, idle
 * time after load, or the page going away. Never rejects: a failed optional
 * bundle must not surface as an unhandled rejection or a broken interaction.
 *
 * Outside a DOM there is nothing to wait for, so it loads immediately.
 */
export function whenUseful(load: () => Promise<unknown>): void {
  let started = false
  let detach = () => {}
  const run = () => {
    if (started) return
    started = true
    detach()
    void load().catch(() => {})
  }
  const onIntent = () => run()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') run()
  }

  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    run()
    return
  }

  if (document.readyState === 'complete') whenIdle(run)
  else window.addEventListener('load', () => whenIdle(run), { once: true })
  for (const event of INTENTS) window.addEventListener(event, onIntent, { capture: true, passive: true })
  window.addEventListener('visibilitychange', onVisibility)
  detach = () => {
    for (const event of INTENTS) window.removeEventListener?.(event, onIntent, true)
    window.removeEventListener?.('visibilitychange', onVisibility)
  }
}

/** Vercel Web Analytics. `inject()` adds the script tag; nothing waits on it. */
export function loadWebAnalytics(): Promise<unknown> {
  return import('@vercel/analytics').then(({ inject }) => inject())
}