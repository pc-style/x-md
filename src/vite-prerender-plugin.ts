import type { Plugin } from 'vite'
import { landingHtml } from './landing'
import { pageBuilders, type PageSlug } from './pages'

// `<div id="app"></div>` on the landing page, `data-page="about"` and friends
// on the static content pages.
const APP_SHELL = /<div id="app"(?: data-page="([a-z]+)")?><\/div>/

/**
 * Renders each page's markup into its root HTML file at build time.
 *
 * Without this the pages ship as an empty `#app` shell, so crawlers and agents
 * that do not run JavaScript see no content at all. `main.ts` and `page.ts`
 * detect the pre-rendered markup and enhance it instead of re-rendering.
 */
export function prerenderLandingPlugin(): Plugin {
  return {
    name: 'x-md-prerender-landing',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const shell = html.match(APP_SHELL)
        if (!shell) return html
        const slug = shell[1] as PageSlug | undefined
        const body = slug ? pageBuilders[slug]?.() : landingHtml()
        if (!body) return html
        return html.replace(shell[0], `<div id="app"${slug ? ` data-page="${slug}"` : ''}>${body}</div>`)
      },
    },
  }
}
