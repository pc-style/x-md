import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const retiredArchiveOutputs = [
  'dist/docs/archive',
  'dist/docs/archive.md',
  'dist/docs/archive.mdx',
  'dist/og/docs/archive.png',
]

for (const path of retiredArchiveOutputs) {
  rmSync(resolve(import.meta.dirname, '..', path), { force: true, recursive: true })
}
