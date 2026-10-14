import { defineConfig } from 'blume'
import { vercel } from 'blume/analytics'
import { orama } from 'blume/search'
import type { LocalFontConfig } from 'blume'

/**
 * The same self-hosted, Latin-subsetted Satoshi the landing page loads
 * (`bun run fonts:build`), at the same weights.
 *
 * Resolving the family through Fontshare instead downloaded six unsubsetted
 * 25 kB faces on every docs page, and resolved them through a third party the
 * reader had not connected to yet. These are the same typeface with identical
 * advance widths, at a third of the bytes, and a reader who arrived from the
 * landing page already has them.
 */
const satoshi: LocalFontConfig = {
  name: 'Satoshi',
  variants: [
    { src: 'public/fonts/satoshi-400-b4e41e08.woff2', weight: 400 },
    { src: 'public/fonts/satoshi-500-5e66a0b1.woff2', weight: 500 },
    { src: 'public/fonts/satoshi-700-03127b3b.woff2', weight: 700 },
    { src: 'public/fonts/satoshi-400-italic-c38203b7.woff2', weight: 400, style: 'italic' },
    { src: 'public/fonts/satoshi-500-italic-0a3f54a4.woff2', weight: 500, style: 'italic' },
    { src: 'public/fonts/satoshi-700-italic-b2f9998d.woff2', weight: 700, style: 'italic' },
  ],
}

export default defineConfig({
  title: 'x.md docs',
  description: 'Read X posts, search, and profiles as Markdown or JSON. Start with one request.',
  basePath: '/docs',
  logo: { text: 'x.md', href: '/' },
  content: { root: 'docs' },
  deployment: { site: 'https://mdfromx.com' },
  theme: {
    accent: 'green',
    radius: 'lg',
    // Follow the reader's system setting, as the landing page does; both store
    // an explicit choice under the same `blume-theme` key.
    mode: 'system',
    fonts: {
      body: satoshi,
      display: satoshi,
    },
  },
  navigation: {
    sidebar: [
      '/',
      {
        label: 'API',
        icon: 'code',
        items: [
          '/posts',
          '/search',
          '/profiles',
          '/bulk-import',
          '/pagination',
          '/responses',
          '/reliability',
          '/errors',
          '/versioning',
        ],
      },
      '/sdk',
      '/agents',
      '/mcp',
      '/self-hosting',
    ],
    // Blume prefixes navigation links with /docs; step back to the site root.
    actions: [{ label: 'Website', href: '/../' }],
    cta: { label: 'Convert', href: '/../#convert' },
  },
  github: { owner: 'pc-style', repo: 'x-md', branch: 'main' },
  lastModified: 'git',
  search: orama(),
  analytics: [vercel()],
  agents: {
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
      site: 'mdfromx.com/docs',
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
    code: {
      theme: { light: 'github-light', dark: 'github-dark' },
    },
  },
})
