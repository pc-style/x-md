/**
 * Render lib/openapi.ts to public/openapi.json.
 *
 * The generated file is committed, so a normal `vite build` publishes it
 * without running this script: Vite copies public/ into dist/ last (with
 * emptyOutDir off), which is what makes it override the OpenAPI document
 * blume generates for its own docs API.
 *
 *   bun scripts/build-openapi.ts          regenerate the committed file
 *   bun scripts/build-openapi.ts --check  fail if it is stale (CI)
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openapiDocument, openapiJson } from '../lib/openapi.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const target = resolve(root, 'public/openapi.json')
const rendered = openapiJson()
const operations = Object.keys(openapiDocument().paths).length
const label = relative(root, target)

function current(): string | undefined {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return undefined
  }
}

if (process.argv.includes('--check')) {
  if (current() === rendered) {
    console.log(`openapi: ${label} is up to date (${operations} operations)`)
  } else {
    console.error(`openapi: ${label} is stale. Run \`bun scripts/build-openapi.ts\` and commit the result.`)
    process.exit(1)
  }
} else if (current() === rendered) {
  console.log(`openapi: ${label} already current (${operations} operations)`)
} else {
  writeFileSync(target, rendered)
  console.log(`openapi: wrote ${label} (${operations} operations, ${rendered.length} bytes)`)
}
