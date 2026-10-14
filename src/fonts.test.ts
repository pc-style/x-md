import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { FACES, UNICODE_RANGES, check } from '../scripts/build-fonts'

/**
 * The site self-hosts a Latin-subsetted Satoshi in `public/fonts/`
 * (`bun run fonts:build`). Subsetting is what took the landing page from 73 kB
 * of webfonts to 23 kB, but a glyph outside the subset does not fail the build:
 * it silently falls back to the next family in `--font-sans`, which looks like a
 * different typeface in the middle of a sentence.
 *
 * These tests read the copy the pages and the docs actually render, so a change
 * that needs a character the subset dropped fails here instead of in a
 * screenshot.
 */
const ROOT = join(import.meta.dirname, '..')
const FONT_DIR = join(ROOT, 'public', 'fonts')
const CSS = join(ROOT, 'src', 'style.css')

/** Every source file whose text can end up rendered in the sans stack. */
const COPY_SOURCES = [
  'src/landing.ts',
  'src/pages.ts',
  'src/chrome.ts',
  'src/main.ts',
  'src/page.ts',
  'index.html',
  'about.html',
  'contact.html',
  'privacy.html',
  'terms.html',
]

/** The docs build renders its own markdown through the same family. */
function docSources(dir = join(ROOT, 'docs')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? docSources(path) : /\.mdx?$/.test(entry.name) ? [path] : []
  })
}

/**
 * The committed subset's range, parsed from the build script rather than copied
 * here, so the two cannot drift. Kept as a list of pairs so a failure can name
 * the code point.
 */
const codePoint = (part: string) => parseInt(part.replace(/^U\+/, ''), 16)
const SUBSET_RANGES: [number, number][] = UNICODE_RANGES.map(range => {
  const [from, to = from] = range.split('-')
  return [codePoint(from), codePoint(to)]
})

/**
 * Emoji and variation selectors render from the system emoji font, which every
 * browser appends to the sans stack and which no Satoshi face has ever covered,
 * subsetted or not. They cannot fall back to a different typeface mid-sentence,
 * so they are outside what this test is guarding.
 */
const SYMBOL_RANGES: [number, number][] = [
  [0x2600, 0x27bf], // dingbats, hearts, arrows-as-emoji
  [0xfe00, 0xfe0f], // variation selectors
  [0x200d, 0x200d], // zero-width joiner
  [0x1f000, 0x1faff], // emoji
]

const inSubset = (codePoint: number) => SUBSET_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)
  || SYMBOL_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)

/**
 * Markup, template syntax and CSS are stripped: only characters that reach the
 * rendered text of a page matter, and `<div class="...">` has no business
 * forcing a glyph into a webfont.
 */
function renderedText(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s*(\/\/|\/\*|\*).*$/gm, ' ')
    .replace(/\$\{[^}]*\}/g, ' ')
    .replace(/[A-Za-z_$][\w$]*(\.[\w$]+)*\s*[:=(]/g, ' ')
    .replace(/[{}\[\]()]/g, ' ')
    .replace(/[\w-]+\.(woff2|ts|css|html|mdx?|json|svg|tsx?)\b/g, ' ')
    .replace(/[\\/][\w./-]+/g, ' ')
    .replace(/[=:;,|]/g, ' ')
    .replace(/[#@*%^~]/g, ' ')
}

test('every character the pages and the docs render is inside the committed font subset', () => {
  const sources = [...COPY_SOURCES.map(file => join(ROOT, file)), ...docSources()]
  const missing = new Map<string, string>()
  for (const file of sources) {
    for (const char of renderedText(readFileSync(file, 'utf8'))) {
      const codePoint = char.codePointAt(0)!
      if (codePoint < 0x20 || inSubset(codePoint)) continue
      missing.set(char, `${file.replace(ROOT + '/', '')} U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`)
    }
  }
  expect(
    Object.fromEntries(missing),
    'Copy renders a character the Satoshi subset drops; add it to UNICODES in scripts/build-fonts.ts and re-run `bun run fonts:build`',
  ).toEqual({})
})

test('the docs API reference renders no character the subset drops', () => {
  // The docs build also renders field descriptions straight out of the OpenAPI
  // document, which is generated and can gain a character without any test here
  // seeing the prose change.
  const description = readFileSync(join(ROOT, 'public', 'openapi.json'), 'utf8')
    .replace(/"([a-z]+)\(\)/gi, ' ')
    .replace(/[{}[\]"]/g, ' ')
  const missing = [...new Set([...description])]
    .map(char => [char, char.codePointAt(0)!] as const)
    .filter(([, codePoint]) => codePoint >= 0x80 && !inSubset(codePoint))
  expect(missing.map(([char, codePoint]) => `${char} U+${codePoint.toString(16).toUpperCase()}`)).toEqual([])
})

test('every committed face exists, matches its content digest, and carries the license', () => {
  // `check` is what `bun run fonts:check` runs: one file per face, named after
  // its own digest. Running it here means a re-subset nobody committed, or a
  // hand-edited woff2, fails `bun run test`.
  expect(() => check()).not.toThrow()
  const committed = readdirSync(FONT_DIR).filter(name => name.endsWith('.woff2')).sort()
  expect(committed).toEqual(FACES.map(face => nameOf(face)).sort())
  for (const face of FACES) {
    expect(readFileSync(join(FONT_DIR, nameOf(face))).byteLength).toBeGreaterThan(1000)
  }
  expect(readFileSync(join(ROOT, 'docs-assets', 'fonts', 'LICENSE-Satoshi.txt'), 'utf8'))
    .toContain('ITF Free Font License')
})

/** The one committed file for a face, derived the way the build names it. */
function nameOf(face: (typeof FACES)[number]): string {
  const pattern = new RegExp(`^${face.stem}-[0-9a-f]{8}\\.woff2$`)
  const files = readdirSync(FONT_DIR).filter(name => pattern.test(name))
  expect(files, `expected one ${face.stem}-*.woff2 in public/fonts`).toHaveLength(1)
  return files[0]
}

test('the landing stylesheet declares the subset, not the unsubsetted faces', () => {
  const css = readFileSync(CSS, 'utf8')
  expect(css).not.toContain('api.fontshare.com')
  expect(css.match(/@font-face/g)).toHaveLength(3)
  for (const weight of [500, 700, 900]) {
    const face = FACES.find(f => f.weight === weight && f.style === 'normal')!
    expect(css).toContain(`font-weight: ${weight}`)
    expect(css).toContain(`url('/fonts/${nameOf(face)}')`)
    // swap keeps the first paint on the system fallback rather than blocking it.
    expect(css.match(/font-display: swap/g)).toHaveLength(3)
  }
})

test('every public page preloads the exact face its stylesheet declares for 900', () => {
  const face = FACES.find(f => f.weight === 900 && f.style === 'normal')!
  const href = `/fonts/${nameOf(face)}`
  for (const file of ['index.html', 'about.html', 'contact.html', 'privacy.html', 'terms.html']) {
    expect(readFileSync(join(ROOT, file), 'utf8'), `${file} preloads a stale font`)
      .toContain(`<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`)
  }
})

test('the docs load the same committed faces instead of a provider', () => {
  const config = readFileSync(join(ROOT, 'blume.config.ts'), 'utf8')
  expect(config).not.toContain("provider: 'fontshare'")
  const declared = [...config.matchAll(/src: 'public\/fonts\/([^']+)'/g)].map(match => match[1]).sort()
  expect(declared).toEqual(
    FACES.filter(face => face.weight !== 900).map(face => nameOf(face)).sort(),
  )
  for (const file of declared) expect(existsSync(resolve(ROOT, 'public', 'fonts', file))).toBe(true)
})