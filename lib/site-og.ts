import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { renderOgImage } from '../.cache/blume-og.mjs'
import { domainText } from './domain-pages.js'

type OgPage = { title: string; description?: string }

const RENDERS_KEPT = 64
const renders = new Map<string, Promise<Uint8Array>>()
let logo: Promise<string> | undefined

/** Card text for an OG image; rejects with ENOENT for a docs page that does not exist. */
export async function siteOgPage(file: string): Promise<OgPage> {
  if (file === 'og.png') return { title: 'Tweets are just markdown now.', description: 'Read any public X post, thread, or profile as clean Markdown. One URL swap.' }
  const pagesRoot = resolve(process.cwd(), 'dist/api/docs/pages')
  const metadata = resolve(pagesRoot, file.slice(3).replace(/\.png$/, '.json'))
  if (!metadata.startsWith(pagesRoot + sep)) throw new Error('Invalid OG metadata path')
  return JSON.parse(await readFile(metadata, 'utf8')) as OgPage
}

/** The same renderer and fonts as Blume's build, with the incoming host. Renders are kept per host and file. */
export function renderSiteOg(file: string, origin: string): Promise<Uint8Array> {
  const key = `${origin} ${file}`
  const cached = renders.get(key)
  if (cached) {
    renders.delete(key)
    renders.set(key, cached)
    return cached
  }
  const render = renderFresh(file, origin)
  renders.set(key, render)
  render.catch(() => { if (renders.get(key) === render) renders.delete(key) })
  if (renders.size > RENDERS_KEPT) renders.delete(renders.keys().next().value!)
  return render
}

async function renderFresh(file: string, origin: string): Promise<Uint8Array> {
  const root = process.cwd()
  const docs = file !== 'og.png'
  const page = await siteOgPage(file)
  logo ??= readFile(resolve(root, 'public/logo.svg'), 'utf8')
  logo.catch(() => { logo = undefined })
  return new Uint8Array(await renderOgImage({
    title: domainText(page.title, origin),
    description: page.description && domainText(page.description, origin),
    brand: docs ? 'x.md docs' : 'x.md',
    site: `${new URL(origin).host}${docs ? '/docs' : ''}`,
    logo: await logo,
    palette: {
      background: '#f7f6f2', foreground: '#1a1915', muted: '#6e6b62',
      accent: '#146c43', border: '#e5e2d9',
    },
    families: { title: 'Satoshi', body: 'Satoshi' },
    // Blume reads and registers each font file once per process, keyed by path.
    fonts: [
      { name: 'Satoshi', src: resolve(root, 'docs-assets/fonts/Satoshi-Bold.otf'), weight: 700 },
      { name: 'Satoshi', src: resolve(root, 'docs-assets/fonts/Satoshi-Regular.otf'), weight: 400 },
    ],
  }))
}
