import type { Plugin } from 'vite'
import { landingHtml } from './landing'

const APP_SHELL = '<div id="app"></div>'

/**
 * Renders the landing markup into `index.html` at build time.
 *
 * Without this the homepage ships as an empty `#app` shell, so crawlers and
 * agents that do not run JavaScript see no content at all. `main.ts` detects
 * the pre-rendered markup and enhances it instead of re-rendering.
 */
export function prerenderLandingPlugin(): Plugin {
  return {
    name: 'x-md-prerender-landing',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!ctx.path.endsWith('/index.html') && ctx.path !== '/') return html
        if (!html.includes(APP_SHELL)) return html
        return html.replace(APP_SHELL, `<div id="app">${landingHtml()}</div>`)
      },
    },
  }
}
