import { defineConfig } from 'blume'

export default defineConfig({
  title: 'x.md docs',
  description: 'Read X posts, search, and profiles as Markdown or JSON. Start with one request.',
  basePath: '/docs',
  logo: { text: 'x.md', href: 'https://x.pcstyle.dev' },
  content: { root: 'docs' },
  deployment: { output: 'static', site: 'https://x.pcstyle.dev' },
  theme: {
    accent: 'green', radius: 'lg', mode: 'light',
    fonts: {
      body: { name: 'Satoshi', provider: 'fontshare' },
      display: { name: 'Satoshi', provider: 'fontshare' },
    },
  },
  navigation: { actions: [{ label: 'Website', href: 'https://x.pcstyle.dev' }] },
  github: { owner: 'pc-style', repo: 'x-md', branch: 'main' },
  search: { provider: 'orama' },
  ai: { llmsTxt: true },
  seo: { og: { enabled: false } },
  markdown: { codeBlocks: { theme: { light: 'github-dark', dark: 'github-dark' } } },
})
