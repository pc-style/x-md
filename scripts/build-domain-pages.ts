import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { renderOgImage } from 'blume/og'
import config from '../blume.config'
import { DOMAIN_PREFIX, domainText } from '../lib/domain-pages'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')
const target = resolve(dist, DOMAIN_PREFIX.slice(1))

async function publish(path: string, body: string | Uint8Array) {
  const destination = resolve(target, path)
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, body)
}

async function walk(path = ''): Promise<void> {
  for (const entry of await readdir(resolve(dist, path), { withFileTypes: true })) {
    const file = path ? `${path}/${entry.name}` : entry.name
    if (['_domains', '_astro', 'assets', 'og'].includes(file)) continue
    if (entry.isDirectory()) { await walk(file); continue }
    if (!/\.(html|md|mdx|txt|json|xml|webmanifest)$/.test(file) && file !== '.well-known/api-catalog') continue
    const source = await readFile(resolve(dist, file), 'utf8')
    let variant = domainText(source)
    // Both production servers remain selectable in either OpenAPI description.
    if (file === 'openapi.json') {
      const document = JSON.parse(variant)
      document.servers = JSON.parse(source).servers
      variant = `${JSON.stringify(document, null, 2)}\n`
    }
    await publish(file, variant)
    if (file.startsWith('api/docs/pages/') && file.endsWith('.json')) {
      const page = JSON.parse(source) as { route: string; title: string; description?: string }
      const og = config.seo!.og!
      const image = await renderOgImage({
        title: domainText(page.title), description: page.description && domainText(page.description),
        brand: config.title, site: 'mdfromx.com/docs', repo: 'pc-style/x-md',
        logo: await readFile(resolve(root, 'public/logo.svg'), 'utf8'),
        palette: og.palette, families: { title: 'Satoshi', body: 'Satoshi' },
        fonts: [
          { name: 'Satoshi', src: resolve(root, 'docs-assets/fonts/Satoshi-Bold.otf'), weight: 700 },
          { name: 'Satoshi', src: resolve(root, 'docs-assets/fonts/Satoshi-Regular.otf'), weight: 400 },
        ],
      })
      await publish(`og${page.route}.png`, new Uint8Array(image))
    }
  }
}

await walk()
await copyFile(resolve(dist, 'og/mdfromx-v1.png'), resolve(target, 'og.png'))
console.log('Published mdfromx.com page, documentation, discovery, and OG variants')
