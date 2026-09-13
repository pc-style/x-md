import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { siteResponse } from './site'

let root: string
const archive = Buffer.from([31, 139, 8, 0, 255, 254])
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'xmd-site-'))
  await mkdir(join(root, 'dist/.well-known/agent-skills'), { recursive: true })
  await writeFile(join(root, 'dist/index.html'), '<a href="https://x.pcstyle.dev/docs">x.pcstyle.dev</a>')
  await writeFile(join(root, 'dist/openapi.json'), JSON.stringify({ servers: [{ url: 'https://x.pcstyle.dev' }, { url: 'https://mdfromx.com' }] }))
  await writeFile(join(root, 'dist/.well-known/agent-skills/browse-x.md'), '# Use https://x.pcstyle.dev')
  await writeFile(join(root, 'dist/.well-known/agent-skills/browse-x.tar.gz'), archive)
  await writeFile(join(root, 'dist/.well-known/agent-skills/index.json'), JSON.stringify({ skills: [
    { type: 'skill-md', url: '/.well-known/agent-skills/browse-x.md', digest: 'old' },
    { type: 'archive', url: '/.well-known/agent-skills/browse-x.tar.gz', digest: 'archive-digest' },
  ] }))
  vi.spyOn(process, 'cwd').mockReturnValue(root)
})
afterAll(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('host-aware public responses', () => {
  test.each(['https://www.elon-dont-c-and-d-me-plz.dev', 'https://future.example', 'http://localhost:5173'])('serves uncached HTML and API discovery on %s', async (origin) => {
    const html = await siteResponse('/', origin)
    expect(html.status).toBe(200)
    expect(html.headers.get('content-type')).toContain('text/html')
    expect(await html.text()).toContain(`href="${origin}/docs"`)
    const doc = await (await siteResponse('/openapi.json', origin)).json()
    expect(doc.servers).toEqual([{ url: origin, description: 'Current host' }])
  })
  test('keeps skill digests consistent with transformed Markdown and preserves binary downloads', async () => {
    const origin = 'https://future.example'
    const index = await (await siteResponse('/.well-known/agent-skills/index.json', origin)).json()
    const md = await (await siteResponse(index.skills[0].url, origin)).text()
    expect(index.skills[0].digest).toBe(`sha256:${createHash('sha256').update(md).digest('hex')}`)
    expect(index.skills[1].digest).toBe('archive-digest')
    const binary = await siteResponse(index.skills[1].url, origin)
    expect(binary.headers.get('content-type')).toBe('application/gzip')
    expect(Buffer.from(await binary.arrayBuffer())).toEqual(archive)
  })
  test('missing pages and traversal return 404', async () => {
    for (const path of ['/docs/missing', '/docs/../../.env', '/api/convert']) {
      expect((await siteResponse(path, 'https://future.example')).status).toBe(404)
    }
  })
})
