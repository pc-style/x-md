import type { Plugin } from 'vite'
import { landingHtml } from './landing'
import { pageBuilders, type PageSlug } from './pages'

// `<div id="app"></div>` on the landing page, `data-page="about"` and friends
// on the static content pages.
const APP_SHELL = /<div id="app"(?: data-page="([a-z]+)")?><\/div>/

const REPO_API = 'https://api.github.com/repos/pc-style/x-md'

/**
 * The repo's star count for the header, read once per build.
 *
 * Any failure (no network, a rate limit, a timeout, an unexpected body) is
 * `null`, and the header then renders the plain GitHub link: the count is
 * never guessed and never fails the build. `GITHUB_TOKEN`, when set, lifts the
 * anonymous rate limit that shared CI addresses run into.
 */
export async function fetchGitHubStars(fetchImpl: typeof fetch = fetch): Promise<number | null> {
  try {
    const token = process.env.GITHUB_TOKEN
    const response = await fetchImpl(REPO_API, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'x-md-build',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return null
    const { stargazers_count: stars } = (await response.json()) as { stargazers_count?: unknown }
    return typeof stars === 'number' && Number.isSafeInteger(stars) && stars >= 0 ? stars : null
  } catch {
    return null
  }
}

/**
 * Renders each page's markup into its root HTML file at build time.
 *
 * Without this the pages ship as an empty `#app` shell, so crawlers and agents
 * that do not run JavaScript see no content at all. `main.ts` and `page.ts`
 * detect the pre-rendered markup and enhance it instead of re-rendering.
 */
export function prerenderLandingPlugin(): Plugin {
  let building = false
  let stars: number | null = null
  return {
    name: 'x-md-prerender-landing',
    configResolved(config) {
      building = config.command === 'build'
    },
    // Once per build, before any page renders. The dev server skips it and
    // shows the plain link rather than calling GitHub on every start.
    async buildStart() {
      if (building) stars = await fetchGitHubStars()
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        const shell = html.match(APP_SHELL)
        if (!shell) return html
        const slug = shell[1] as PageSlug | undefined
        const chrome = { stars }
        const body = slug ? pageBuilders[slug]?.(chrome) : landingHtml(chrome)
        if (!body) return html
        return html.replace(shell[0], `<div id="app"${slug ? ` data-page="${slug}"` : ''}>${body}</div>`)
      },
    },
  }
}
