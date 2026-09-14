import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { domainFile, domainText } from './domain-pages.js'

const TYPES: Record<string, string> = {
  html: 'text/html', md: 'text/markdown', mdx: 'text/plain', txt: 'text/plain',
  json: 'application/json', jsonl: 'application/jsonl', xml: 'application/xml',
  webmanifest: 'application/manifest+json',
}

/** Reads only the public build output; never fetches a caller-controlled host. */
export async function siteResponse(path: string, origin: string): Promise<Response> {
  const file = domainFile(path)
  if (!file) return new Response('Not found', { status: 404 })
  const root = resolve(process.cwd(), 'dist')
  const filename = resolve(root, file)
  if (!filename.startsWith(root + sep)) return new Response('Not found', { status: 404 })
  try {
    let body: string | Uint8Array
    if (file.endsWith('.tar.gz')) {
      body = await readFile(filename)
    } else if (file.endsWith('.png')) {
      const { renderSiteOg } = await import('./site-og.js')
      body = await renderSiteOg(file, origin)
    } else {
      body = domainText(await readFile(filename, 'utf8'), origin)
      if (file === '.well-known/agent-skills/index.json') {
        const index = JSON.parse(body)
        for (const skill of index.skills) {
          if (skill.type !== 'skill-md') continue
          const skillFile = domainFile(skill.url)
          if (!skillFile?.endsWith('.md')) continue
          const content = domainText(await readFile(resolve(process.cwd(), 'dist', skillFile), 'utf8'), origin)
          skill.digest = `sha256:${createHash('sha256').update(content).digest('hex')}`
        }
        body = `${JSON.stringify(index, null, 2)}\n`
      }
      if (file === 'openapi.json') {
        const document = JSON.parse(body)
        document.servers = [{ url: origin, description: 'Current host' }]
        body = `${JSON.stringify(document, null, 2)}\n`
      }
    }
    const type = file.endsWith('.tar.gz') ? 'application/gzip' : file.endsWith('.png') ? 'image/png'
      : file === '.well-known/api-catalog' ? 'application/linkset+json'
      : file === 'openapi.json' ? 'application/vnd.oai.openapi+json'
      : TYPES[file.split('.').at(-1)!] ?? 'text/plain'
    return new Response(body as BodyInit, { headers: {
      'Content-Type': type + (typeof body !== 'string' ? '' : '; charset=utf-8'),
      'Cache-Control': 'public, max-age=300, s-maxage=86400, stale-while-revalidate=604800',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    } })
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return new Response('Not found', { status: 404 })
    throw error
  }
}
