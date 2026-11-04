/**
 * Stamp the docs' configured theme onto every built docs page's <html>.
 * The mode is the one Blume renders for its theme script (`data-mode`, from
 * `theme.mode` in blume.config.ts), so the config stays the only source.
 *
 * Blume sets `data-theme` only from its inline head script, and all of its dark
 * styling (Tailwind `dark:` variants, Shiki, prose) keys off `[data-theme=dark]`,
 * so with JavaScript off the docs rendered light. AGENTS.md has them dark by
 * default, as the landing and content pages are. The inline script still runs
 * before first paint and replaces this value with a stored choice, and Blume's
 * `astro:before-swap` carries that choice across client-side navigations.
 *
 * A post-build step rather than a `patches/` entry for Blume: Vercel installs
 * with bun 1.3.14, which drops a patched package's nested `node_modules` when it
 * patches a cached install, so Blume lost its own TypeScript and the build
 * failed.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** The fixed mode Blume's theme script was rendered with, if any. */
export const themeMode = (html: string): string | undefined => /<script\b[^>]*\sdata-mode="(dark|light)"/.exec(html)?.[1]

/** The page with its configured mode as `data-theme` on its root element; unchanged for `system`, which only the browser can resolve, or when the root already has one. */
export function withTheme(html: string): string {
  const mode = themeMode(html)
  if (!mode) return html
  return html.replace(/<html(?![^>]*\sdata-theme=)(?=[\s>])/i, `<html data-theme="${mode}"`)
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '../dist/docs')
  const pages = (await readdir(root, { recursive: true })).filter((file) => file.endsWith('.html'))
  let stamped = 0
  for (const page of pages) {
    const path = join(root, page)
    const html = await readFile(path, 'utf8')
    const next = withTheme(html)
    if (next !== html) {
      await writeFile(path, next)
      stamped += 1
    }
  }
  if (!pages.length) throw new Error(`${root} has no pages: run the docs build first`)
  console.log(`docs theme: stamped ${stamped} of ${pages.length} pages`)
}

if (import.meta.main) await main()
