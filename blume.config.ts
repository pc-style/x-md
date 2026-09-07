import { defineConfig } from 'blume'

export default defineConfig({
  title: 'x.md docs',
  description: 'Read X posts, search, and profiles as Markdown or JSON. Start with one request.',
  basePath: '/docs',
  logo: { text: 'x.md', href: 'https://x.pcstyle.dev' },
  content: { root: 'docs' },
  deployment: {
    output: 'static',
    site: 'https://x.pcstyle.dev',
  },
  theme: {
    accent: 'green',
    radius: 'lg',
    mode: 'light',
    fonts: {
      body: { name: 'Satoshi', provider: 'fontshare' },
      display: { name: 'Satoshi', provider: 'fontshare' },
    },
  },
  navigation: {
    sidebar: [
      '/',
      {
        label: 'API',
        icon: 'code',
        items: ['/posts', '/search', '/profiles', '/pagination', '/responses', '/reliability'],
      },
      '/agents',
      '/self-hosting',
    ],
    actions: [{ label: 'Website', href: 'https://x.pcstyle.dev' }],
    cta: { label: 'Convert', href: 'https://x.pcstyle.dev/#convert' },
  },
  github: { owner: 'pc-style', repo: 'x-md', branch: 'main' },
  lastModified: true,
  search: { provider: 'orama' },
  analytics: { vercel: true },
  ai: {
    llmsTxt: true,
    skills: './skills',
  },
  seo: {
    og: {
      enabled: true,
      // Fontshare fonts can't flow into the card renderer, so the card reads Satoshi from local files.
      fonts: [
        { name: 'Satoshi', src: 'docs-assets/fonts/Satoshi-Bold.otf', weight: 700 },
        { name: 'Satoshi', src: 'docs-assets/fonts/Satoshi-Regular.otf', weight: 400 },
      ],
      logo: 'public/logo.svg',
      site: 'x.pcstyle.dev/docs',
      palette: {
        background: '#f7f6f2',
        foreground: '#1a1915',
        muted: '#6e6b62',
        accent: '#146c43',
        border: '#e5e2d9',
      },
    },
    x: { handle: '@pcstyle53', creator: '@pcstyle53' },
  },
  markdown: {
    codeBlocks: {
      theme: { light: 'github-dark', dark: 'github-dark' },
    },
  },
})
