import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { renderOgImage } from '../.cache/blume-og.mjs'
import { domainText } from './domain-pages.js'

/** The same renderer and fonts as Blume's build, with the incoming host. */
export async function renderSiteOg(file: string, origin: string): Promise<Uint8Array> {
  const root = process.cwd()
  const docs = file !== 'og.png'
  const page = docs
    ? JSON.parse(await readFile(resolve(root, 'dist/api/docs/pages', file.slice(3).replace(/\.png$/, '.json')), 'utf8')) as { title: string; description?: string }
    : { title: 'Tweets are just markdown now.', description: 'Read any public X post, thread, or profile as clean Markdown. One URL swap.' }
  return new Uint8Array(await renderOgImage({
    title: domainText(page.title, origin),
    description: page.description && domainText(page.description, origin),
    brand: docs ? 'x.md docs' : 'x.md',
    site: `${new URL(origin).host}${docs ? '/docs' : ''}`,
    logo: await readFile(resolve(root, 'public/logo.svg'), 'utf8'),
    palette: {
      background: '#f7f6f2', foreground: '#1a1915', muted: '#6e6b62',
      accent: '#146c43', border: '#e5e2d9',
    },
    families: { title: 'Satoshi', body: 'Satoshi' },
    fonts: [
      { name: 'Satoshi', src: resolve(root, 'docs-assets/fonts/Satoshi-Bold.otf'), weight: 700 },
      { name: 'Satoshi', src: resolve(root, 'docs-assets/fonts/Satoshi-Regular.otf'), weight: 400 },
    ],
  }))
}
