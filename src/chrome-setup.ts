/**
 * What the shared chrome does once the page is interactive: the mobile menu,
 * the theme toggle, and same-origin link prefetch. Kept apart from the markup
 * in `chrome.ts`, which only the build (and the dev fallback) needs, so the
 * entry chunks every page loads before first render carry just this.
 */
export function setupMobileMenu(root: HTMLElement) {
  const toggle = root.querySelector<HTMLButtonElement>('[data-menu-toggle]')
  const menu = root.querySelector<HTMLElement>('#mobile-menu')
  if (!toggle || !menu) return

  const close = () => {
    delete menu.dataset.open
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', 'Open menu')
  }

  toggle.addEventListener('click', () => {
    const open = menu.dataset.open !== undefined
    if (open) {
      close()
    } else {
      menu.dataset.open = ''
      toggle.setAttribute('aria-expanded', 'true')
      toggle.setAttribute('aria-label', 'Close menu')
    }
  })

  menu.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) close()
  })
}

/** Blume's key: the docs and the landing pages share one stored theme. */
const THEME_KEY = 'blume-theme'

export function setupTheme(root: HTMLElement) {
  const toggle = root.querySelector<HTMLButtonElement>('[data-theme-toggle]')
  if (!toggle) return

  // The head script has already applied the stored choice, or the dark default;
  // the system setting no longer decides, so there is nothing to follow here.
  const apply = (theme: 'light' | 'dark') => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#080b09' : '#f7f6f2',
    )
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`)
  }

  toggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Storage can be unavailable in sandboxed or privacy-restricted contexts.
    }
    apply(next)
  })

  apply(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
}

export function setupLinkPrefetch(root: HTMLElement) {
  const prefetched = new Set<string>()

  const prefetch = (target: EventTarget | null) => {
    const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
    if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return

    const url = new URL(anchor.href, window.location.href)
    if (url.origin !== window.location.origin) return

    url.hash = ''
    const href = `${url.pathname}${url.search}`
    const current = `${window.location.pathname}${window.location.search}`
    if (href === current || prefetched.has(href)) return

    prefetched.add(href)
    const link = document.createElement('link')
    link.rel = 'prefetch'
    link.href = href
    link.setAttribute('fetchpriority', 'low')
    document.head.append(link)
  }

  root.addEventListener('pointerover', (event) => prefetch(event.target), { passive: true })
  root.addEventListener('focusin', (event) => prefetch(event.target))
  root.addEventListener('touchstart', (event) => prefetch(event.target), { passive: true })
}
