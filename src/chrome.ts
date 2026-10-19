/**
 * The shared header and footer markup for the landing and content pages.
 *
 * Pure string builders, like `landing.ts` and `pages.ts`: the prerender plugin
 * renders them into each page at build time. Their behaviour is in
 * `chrome-setup.ts`.
 */
type NavItem = { label: string; href: string }

/** Which root page the chrome is rendered into; drives in-page vs. absolute links. */
export type PageKind = 'landing' | 'docs' | 'about' | 'contact' | 'privacy' | 'terms'

const NAV_ITEMS: NavItem[] = [
  { label: 'Convert', href: '/#convert' },
  { label: 'Agents', href: '/#agents' },
  { label: 'Docs', href: '/docs' },
  { label: 'API', href: '/docs/posts' },
]

/** Build-time data for the chrome. `stars` is the repo's live star count, or absent when it could not be read. */
export type ChromeData = { stars?: number | null }

const REPO_URL = 'https://github.com/pc-style/x-md'

/** `162`, `1.2k`, `12.3k`: the compact form the header shows, as GitHub does. */
export function formatStars(stars: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(stars).toLowerCase()
}

/** The GitHub mark (simple-icons, CC0) and a plain five-point star; icons are SVG so the font subset never needs a glyph. */
const GITHUB_MARK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`

const STAR = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`

export function headerHtml(options: { page: PageKind } & ChromeData) {
  const items = NAV_ITEMS.map((item) => {
    const current = options.page === 'docs' && item.href === '/docs'
    return `<a href="${item.href}" class="nav-link h-9 px-3"${current ? ' aria-current="page"' : ''}>${item.label}</a>`
  }).join('\n        ')

  // The count is read at build time and never guessed: without it the link is
  // the plain GitHub link.
  const stars = typeof options.stars === 'number' ? formatStars(options.stars) : null
  const github = stars
    ? `<a href="${REPO_URL}" target="_blank" rel="noreferrer" class="nav-link nav-github hidden h-9 px-3 sm:flex" aria-label="GitHub, ${stars} stars">${GITHUB_MARK}<span class="nav-stars">${STAR}${stars}</span></a>`
    : `<a href="${REPO_URL}" target="_blank" rel="noreferrer" class="nav-link nav-github hidden h-9 px-3 sm:flex">${GITHUB_MARK}GitHub</a>`

  const mobileItems = [
    ...NAV_ITEMS.map((item) => `<a href="${item.href}">${item.label}</a>`),
    `<a href="${REPO_URL}">GitHub${stars ? ` <span class="text-ink-4">· ${stars} stars</span>` : ''}</a>`,
  ].join('\n      ')

  const cta =
    options.page === 'landing'
      ? `<a href="#convert" class="btn-primary h-9 px-4 text-[13.5px]">Convert</a>`
      : `<a href="/#convert" class="btn-primary h-9 px-4 text-[13.5px]">Convert</a>`

  // On the landing page the header starts transparent over the dark hero; see
  // `.site-header` in style.css and the scroll flag in index.html.
  return `
  <header class="site-header"${options.page === 'landing' ? ' data-over="night"' : ''}>
    <nav aria-label="Primary" class="site-header-inner">
      <a href="/" class="text-wordmark font-wordmark tracking-wordmark text-ink">x.md</a>
      <div class="hidden items-center gap-1 md:flex">
        ${items}
      </div>
      <div class="flex items-center gap-2">
        ${github}
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

type FooterGroup = { heading: string; links: { label: string; href: string; external?: boolean }[] }

/**
 * Descriptive, crawlable links to everything an agent needs: the docs, the
 * machine-readable descriptions of the API, and the about/contact/privacy/terms
 * pages that verify who runs the service. Rendered into every root page.
 */
const FOOTER_GROUPS: FooterGroup[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Convert a post', href: '/#convert' },
      { label: 'Point an agent at x.md', href: '/#agents' },
      { label: 'Source code on GitHub', href: 'https://github.com/pc-style/x-md', external: true },
    ],
  },
  {
    heading: 'Developers',
    links: [
      { label: 'API documentation', href: '/docs' },
      { label: 'API reference: posts', href: '/docs/posts' },
      { label: 'OpenAPI description', href: '/openapi.json' },
      { label: 'llms.txt', href: '/llms.txt' },
      { label: 'MCP server', href: '/mcp' },
    ],
  },
  {
    heading: 'Project',
    links: [
      { label: 'About x.md', href: '/about' },
      { label: 'Contact', href: '/contact' },
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
]

export function footerHtml(page?: PageKind) {
  const groups = FOOTER_GROUPS.map(
    (group) => `<div>
            <h2 class="footer-heading">${group.heading}</h2>
            <ul class="footer-list">
              ${group.links
                .map((link) => {
                  const current = page !== undefined && link.href === `/${page}`
                  const attrs = `${link.external ? ' target="_blank" rel="noreferrer"' : ''}${current ? ' aria-current="page"' : ''}`
                  return `<li><a href="${link.href}" class="footer-link"${attrs}>${link.label}</a></li>`
                })
                .join('\n              ')}
            </ul>
          </div>`,
  ).join('\n          ')

  return `
  <footer class="site-footer">
    <div class="mx-auto flex max-w-[1200px] flex-col gap-10 px-6 py-14 sm:px-8">
      <div class="flex flex-col gap-10 lg:flex-row lg:justify-between">
        <div class="max-w-[34ch]">
          <a href="/" class="text-wordmark font-wordmark tracking-wordmark text-ink">x.md</a>
          <p class="mt-3 text-[13.5px] leading-relaxed text-ink-3">
            Read public X posts, threads, profiles, and search results as Markdown or JSON.
            Read-only, open source, no account required.
          </p>
        </div>
        <nav aria-label="Footer" class="grid gap-8 sm:grid-cols-3 lg:gap-16">
          ${groups}
        </nav>
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
