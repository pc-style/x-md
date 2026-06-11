#!/usr/bin/env bun
/**
 * Read a public X status URL and print Markdown (or JSON) to stdout.
 * Uses the same converter as /api/convert (FxTwitter → syndication → Context.dev → Firecrawl).
 */
import { writeFileSync } from 'node:fs'
import { ConvertError, convertTweet, markdownResponse } from '../lib/converter.js'

function usage(): never {
  console.error(`Usage: bun scripts/read-x.ts <x-status-url> [options]

Options:
  --format markdown|obsidian   Output format (default: markdown)
  --thread off|full|conversation|N   Thread mode (default: full)
  --userinfo off|author|all    Author metadata (default: off)
  --json                       Emit JSON instead of Markdown
  --nocache                    Bypass converter cache
  --out <file>                 Write body to file instead of stdout

Examples:
  bun scripts/read-x.ts "https://x.com/handle/status/123"
  bun scripts/read-x.ts "https://x.com/handle/status/123" --thread full --userinfo author
  bun scripts/read-x.ts "https://x.com/handle/status/123" --format obsidian --out post.md
`)
  process.exit(2)
}

const args = process.argv.slice(2)
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') usage()

let url: string | undefined
let format: string | undefined
let thread: string | undefined
let userinfo: string | undefined
let asJson = false
let nocache: string | undefined
let outFile: string | undefined

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (!arg.startsWith('--') && !url) {
    url = arg
    continue
  }
  switch (arg) {
    case '--format':
      format = args[++i]
      break
    case '--thread':
      thread = args[++i]
      break
    case '--userinfo':
      userinfo = args[++i]
      break
    case '--json':
      asJson = true
      break
    case '--nocache':
      nocache = '1'
      break
    case '--out':
      outFile = args[++i]
      break
    default:
      console.error(`Unknown option: ${arg}`)
      usage()
  }
}

if (!url) usage()

try {
  const result = await convertTweet({ url, format, thread, userinfo, nocache })
  const { body } = markdownResponse(result, asJson)

  if (outFile) {
    writeFileSync(outFile, body, 'utf8')
    console.error(`Wrote ${outFile} (${result.source}, ${result.postCount} post(s))`)
  } else {
    process.stdout.write(body)
    if (!body.endsWith('\n')) process.stdout.write('\n')
  }

  if (result.warnings.length > 0) {
    for (const w of result.warnings) console.error(`warning: ${w}`)
  }
} catch (error) {
  if (error instanceof ConvertError) {
    console.error(`error [${error.code}]: ${error.message}`)
    process.exit(error.status === 400 ? 2 : 1)
  }
  console.error(error)
  process.exit(1)
}
