// Blume exports TypeScript source. Bundle its renderer before Vercel traces the
// function, so package exports cannot point at .ts files Vercel renamed to .js.
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const result = await Bun.build({
  entrypoints: [import.meta.resolve('blume/og').replace('file://', '')],
  outdir: resolve(import.meta.dirname, '../.cache'),
  naming: 'blume-og.mjs',
  target: 'node',
  external: ['takumi-js', 'takumi-js/*'],
})
if (!result.success) throw new AggregateError(result.logs, 'Could not bundle the OG renderer')
await writeFile(resolve(import.meta.dirname, '../.cache/blume-og.d.mts'), "export { renderOgImage } from 'blume/og'\n")
console.log('Bundled Blume OG renderer for Node')
