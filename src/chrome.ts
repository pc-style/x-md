type NavItem = { label: string; href: string }

const NAV_ITEMS: NavItem[] = [
  { label: 'Convert', href: '/#convert' },
  { label: 'Agents', href: '/#agents' },
  { label: 'Docs', href: '/docs' },
  { label: 'API', href: '/docs/posts' },
]

export function headerHtml(options: { page: 'landing' | 'docs' }) {
  const items = NAV_ITEMS.map((item) => {
    const current = options.page === 'docs' && item.href === '/docs'
    return `<a href="${item.href}" class="nav-link h-9 px-3"${current ? ' aria-current="page"' : ''}>${item.label}</a>`
  }).join('\n        ')

  const mobileItems = [...NAV_ITEMS, { label: 'GitHub', href: 'https://github.com/pc-style/x-md' }]
    .map((item) => `<a href="${item.href}">${item.label}</a>`)
    .join('\n      ')

  const cta =
    options.page === 'docs'
      ? `<a href="/#convert" class="btn-primary h-9 px-4 text-[13.5px]">Convert</a>`
      : `<a href="#convert" class="btn-primary h-9 px-4 text-[13.5px]">Convert</a>`

  return `
  <header class="site-header">
    <nav aria-label="Primary" class="site-header-inner">
      <a href="/" class="text-[17px] font-black tracking-tight text-ink">x.md</a>
      <div class="hidden items-center gap-1 md:flex">
        ${items}
      </div>
      <div class="flex items-center gap-2">
        <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="nav-link hidden h-9 px-3 sm:flex">GitHub</a>
        <button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch to dark mode" title="Switch color theme">
          <svg class="theme-icon theme-icon-moon" width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M16.3 12.9A7 7 0 0 1 7.1 3.7 7 7 0 1 0 16.3 12.9Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <svg class="theme-icon theme-icon-sun" width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="10" cy="10" r="3.25" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10 1.75v1.5M10 16.75v1.5M18.25 10h-1.5M3.25 10h-1.5M15.83 4.17l-1.06 1.06M5.23 14.77l-1.06 1.06M15.83 15.83l-1.06-1.06M5.23 5.23 4.17 4.17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        ${cta}
        <button type="button" class="menu-toggle" data-menu-toggle aria-expanded="false" aria-controls="mobile-menu" aria-label="Open menu">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 4.5h12M2 8h12M2 11.5h12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
    </nav>
    <div id="mobile-menu" class="mobile-menu">
      ${mobileItems}
    </div>
  </header>`
}

export function footerHtml() {
  return `
  <footer class="site-footer">
    <div class="mx-auto flex max-w-[1200px] flex-col gap-6 px-6 py-14 sm:px-8">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <a href="/" class="text-[17px] font-black tracking-tight text-ink">x.md</a>
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-[14px]">
          <a href="/#convert" class="footer-link">Convert</a>
          <a href="/#agents" class="footer-link">Agents</a>
          <a href="/docs" class="footer-link">Docs</a>
          <a href="/docs/posts" class="footer-link">API</a>
          <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="footer-link">GitHub</a>
        </div>
      </div>
      <div class="flex flex-col-reverse items-start gap-5 border-t border-line pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p class="text-[13.5px] text-ink-4">Open source, MIT. Not affiliated with X Corp.</p>
        <a
          href="https://www.producthunt.com/products/x-md/reviews/new?utm_source=badge-product_review&amp;utm_medium=badge&amp;utm_source=badge-x-md"
          target="_blank"
          rel="noreferrer"
          class="ph-badge"
        >
          <img
            src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=1288590&amp;theme=light"
            alt="x.md - change the host, read the post | Product Hunt"
            width="250"
            height="54"
            loading="lazy"
            class="ph-badge-light"
          />
          <img
            src="https://api.producthunt.com/widgets/embed-image/v1/product_review.svg?product_id=1288590&amp;theme=dark"
            alt="x.md - change the host, read the post | Product Hunt"
            width="250"
            height="54"
            loading="lazy"
            class="ph-badge-dark"
          />
        </a>
      </div>
    </div>
  </footer>`
}

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

export function setupTheme(root: HTMLElement) {
  const toggle = root.querySelector<HTMLButtonElement>('[data-theme-toggle]')
  if (!toggle) return
  const storedTheme = () => {
    try {
      return localStorage.getItem('x-md-theme')
    } catch {
      return null
    }
  }

  const apply = (theme: 'light' | 'dark') => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      theme === 'dark' ? '#11120f' : '#f7f6f2',
    )
    toggle.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`)
  }

  toggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem('x-md-theme', next)
    } catch {
      // Storage can be unavailable in sandboxed or privacy-restricted contexts.
    }
    apply(next)
  })

  const preference = matchMedia('(prefers-color-scheme: dark)')
  preference.addEventListener('change', (event) => {
    if (!storedTheme()) apply(event.matches ? 'dark' : 'light')
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
