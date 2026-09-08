import './style.css'
import { setupLinkPrefetch, setupMobileMenu, setupTheme } from './chrome'
import { pageBuilders, type PageSlug } from './pages'

// Shared entry for the static content pages (about, contact, privacy, terms).
// Deliberately does not load analytics: only the landing page is instrumented.
const app = document.querySelector<HTMLDivElement>('#app')!

// The body is pre-rendered into each root HTML file at build time so the page
// reads without JavaScript. Render here only when that transform did not run.
if (!app.firstElementChild) {
  const slug = app.dataset.page
  const build = slug && slug in pageBuilders ? pageBuilders[slug as PageSlug] : undefined
  if (build) app.innerHTML = build()
}

setupMobileMenu(app)
setupTheme(app)
setupLinkPrefetch(app)
