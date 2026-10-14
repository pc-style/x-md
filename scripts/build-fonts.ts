/**
 * Builds the self-hosted Satoshi webfont subset the public pages render in
 * (`src/style.css` for the landing and content pages, `blume.config.ts` for
 * the docs build).
 *
 * The faces were already self-hosted in `public/fonts/`; they were the whole
 * unsubsetted files api.fontshare.com serves, which carry Cyrillic, Greek and
 * Vietnamese alternates no page here can reach. That cost 25 kB per face, and
 * webfonts were 84% of the landing page's render-blocking bytes and 77% of the
 * docs page's. Subsetting to the range the site actually renders is 7.6-8.5 kB
 * per face, and the advance widths of every glyph it keeps are byte-identical
 * to the originals, so the pages render the same typeface at the same metrics.
 *
 * The ITF Free Font License the repo already ships
 * (`docs-assets/fonts/LICENSE-Satoshi.txt`) permits and recommends self-hosting
 * through standard webfont technologies.
 *
 * The output is committed to `public/fonts/` with a content hash in its name, so
 * a normal `bun run build` never needs the network and the `vercel.json`
 * `immutable` rule for `/fonts/(.*)` keeps applying. Re-run this only when a
 * weight or the subset range changes:
 *
 *   bun run fonts:build      # subset into public/fonts/ (needs fontTools)
 *   bun run fonts:check      # verify the committed files against their digests (no network)
 *
 * Every source face is the exact file api.fontshare.com serves today, pinned by
 * digest, so a swapped or moved upstream file fails loudly instead of silently
 * changing the typeface.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'public', 'fonts')
const CACHE_DIR = join(ROOT, 'node_modules', '.cache', 'x-md-fonts')

export interface Face {
  weight: 400 | 500 | 700 | 900
  style: 'normal' | 'italic'
  url: string
  /** File name stem under `public/fonts/`, without the content hash. */
  stem: string
  /** First 8 hex of the sha256 of the unsubsetted upstream woff2. */
  upstream: string
}

/**
 * The faces each page actually renders, and the exact upstream files
 * api.fontshare.com serves for them, pinned by digest.
 */
export const FACES: Face[] = [
  { weight: 900, style: 'normal', stem: 'satoshi-900',
    url: 'https://cdn.fontshare.com/wf/NHPGVFYUXYXE33DZ75OIT4JFGHITX5PE/PSUTMASCDJTVPERDYJZPN23BVUFUCQIF/J64QX5IPOHK56I2KYUNBQ5M2XWZEYKYX.woff2',
    upstream: 'bd11b582' },
  { weight: 700, style: 'normal', stem: 'satoshi-700',
    url: 'https://cdn.fontshare.com/wf/LAFFD4SDUCDVQEXFPDC7C53EQ4ZELWQI/PXCT3G6LO6ICM5I3NTYENYPWJAECAWDD/GHM6WVH6MILNYOOCXHXB5GTSGNTMGXZR.woff2',
    upstream: '353a7fbf' },
  { weight: 500, style: 'normal', stem: 'satoshi-500',
    url: 'https://cdn.fontshare.com/wf/P2LQKHE6KA6ZP4AAGN72KDWMHH6ZH3TA/ZC32TK2P7FPS5GFTL46EU6KQJA24ZYDB/7AHDUZ4A7LFLVFUIFSARGIWCRQJHISQP.woff2',
    upstream: 'af02a722' },
  { weight: 400, style: 'normal', stem: 'satoshi-400',
    url: 'https://cdn.fontshare.com/wf/TTX2Z3BF3P6Y5BQT3IV2VNOK6FL22KUT/7QYRJOI3JIMYHGY6CH7SOIFRQLZOLNJ6/KFIAZD4RUMEZIYV6FQ3T3GP5PDBDB6JY.woff2',
    upstream: '50dca57f' },
  { weight: 700, style: 'italic', stem: 'satoshi-700-italic',
    url: 'https://cdn.fontshare.com/wf/CDEBEFT2R7XKNGXSBBLZGMY4MMHZG75P/HEVKDGQCYDZ7Z6CDVR2ZQGBCTUD6ZARH/BKWEE3VKGTFABE37K2DTH625VUSN2N35.woff2',
    upstream: '52bfd9e8' },
  { weight: 500, style: 'italic', stem: 'satoshi-500-italic',
    url: 'https://cdn.fontshare.com/wf/NID3I7RITWZSKXRCJGOCMP5NOADJK6IG/2HLHGD7OBTWCOHW64YXOE5KFXHU4KJHM/ZHME2QIRFR7UPJ47NLY27RCAFY44CKZJ.woff2',
    upstream: 'beb15382' },
  { weight: 400, style: 'italic', stem: 'satoshi-400-italic',
    url: 'https://cdn.fontshare.com/wf/MPIFA4B3XXRNY2MJDGP6GOOOAF6EOCLO/W5E4ZFYPJ3V6JKMBGHB6YMITK6EWS2XA/QOMBWPST76ICDYF6WOBS7SQ7RBT67QW2.woff2',
    upstream: 'dbcb8c32' },
]

/** The file a face is committed as: `<stem>-<first 8 hex of its own sha256>.woff2`. */
export const fontFile = (face: Face, digest: string) => `${face.stem}-${digest}.woff2`

/**
 * Everything the site can render in Satoshi: printable ASCII, the typographic
 * punctuation and arrows the copy already uses, and nothing else. Satoshi also
 * ships Cyrillic, Greek and Vietnamese alternates, which are most of the 25 kB
 * the unsubsetted faces cost and which no page here can reach.
 *
 * `src/fonts.test.ts` reads every string the pages and the docs can render and
 * fails if one falls outside this range, so a character that needs adding is
 * caught in CI rather than in a screenshot.
 */
export const UNICODE_RANGES = [
  'U+0020-007E', // printable ASCII
  'U+00A0', // no-break space
  'U+00B7', // middle dot
  'U+2013-2014', // en/em dash
  'U+2018-201F', // curly quotes, low quotes, double primes
  'U+2022', // bullet
  'U+2026', // ellipsis
  'U+2039-203A', // single angle quotes
  'U+2044', // fraction slash
  'U+2190-2193', // arrows
  'U+2212', // minus sign
]

/** What `pyftsubset --unicodes` takes. */
export const UNICODES = UNICODE_RANGES.join(',')

/**
 * Only the features Satoshi ships by default and Latin text can reach: standard
 * ligatures, glyph decomposition and localised forms. `ccmp` and `mark` are
 * asked for but fontTools drops the lookups it cannot keep in a Latin-only
 * subset. Stylistic sets, discretionary ligatures, fractions, old-style
 * figures, ordinals and super/subscripts stay out: nothing on the site turns
 * them on, and `font-variant-numeric: tabular-nums` applies to the admin page,
 * which keeps its own Fontshare import.
 */
const FEATURES = 'kern,liga,ccmp,locl,mark'

/** The one committed file for a face: `<stem>-<first 8 hex of its digest>.woff2`. */
const filePattern = (face: Face) => new RegExp(`^${face.stem}-[0-9a-f]{8}\\.woff2$`)

const committedFaces = (face: Face) => readdirSync(OUT_DIR).filter(name => filePattern(face).test(name))

const cacheFile = (face: Face) => join(CACHE_DIR, `${face.stem}.woff2`)

/** First 8 hex of a file's sha256. */
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)
const label = (face: Face) => `${face.weight}${face.style === 'italic' ? 'i' : ' '}`

const subset = (source: string, target: string) =>
  execFileSync('pyftsubset', [
    `--unicodes=${UNICODES}`,
    `--layout-features=${FEATURES}`,
    '--flavor=woff2',
    '--desubroutinize',
    '--no-hinting',
    '--name-IDs=*',
    '--notdef-outline',
    source,
    `--output-file=${target}`,
  ], { stdio: 'inherit' })

function build(): void {
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(CACHE_DIR, { recursive: true })
  const rows: string[] = []
  const written: string[] = []
  let before = 0
  let after = 0
  for (const face of FACES) {
    const cached = cacheFile(face)
    if (!existsSync(cached)) execFileSync('curl', ['-sSfL', '--max-time', '30', '-o', cached, face.url], { stdio: 'inherit' })
    if (digest(cached) !== face.upstream) {
      throw new Error(`upstream Satoshi ${label(face)} moved (${digest(cached)} != ${face.upstream}); review the new file before shipping it`)
    }
    const scratch = join(CACHE_DIR, `${face.stem}.subset.woff2`)
    subset(cached, scratch)
    const shipped = join(OUT_DIR, fontFile(face, digest(scratch)))
    renameSync(scratch, shipped)
    written.push(shipped)
    const from = readFileSync(cached).length
    const to = readFileSync(shipped).length
    rows.push(`  ${label(face)}  ${(from / 1024).toFixed(1)} kB -> ${(to / 1024).toFixed(1)} kB  ${fontFile(face, digest(shipped))}`)
    before += from
    after += to
  }
  // Any face left over is a weight this range no longer ships.
  for (const stale of readdirSync(OUT_DIR)) {
    if (stale.endsWith('.woff2') && !written.some(file => file.endsWith(stale))) {
      rmSync(join(OUT_DIR, stale))
      rows.push(`  removed ${stale}`)
    }
  }
  console.log(`fonts: wrote ${written.length} Satoshi faces to public/fonts`)
  console.log(rows.join('\n'))
  console.log(`  total ${(before / 1024).toFixed(1)} kB -> ${(after / 1024).toFixed(1)} kB (${Math.round((1 - after / before) * 100)}% smaller)`)
}

/**
 * `--check` is the offline guard: every committed face must exist and match the
 * name its content digest implies. `src/fonts.test.ts` runs the same rule inside
 * `bun run test`, so a re-subset that nobody committed fails CI.
 */
export function check(): void {
  const rows: string[] = []
  let total = 0
  for (const face of FACES) {
    const files = committedFaces(face)
    if (files.length !== 1) {
      throw new Error(`expected exactly one ${face.stem}-*.woff2 in public/fonts, found ${files.length}`)
    }
    const path = join(OUT_DIR, files[0])
    const found = digest(path)
    if (files[0] !== fontFile(face, found)) {
      throw new Error(`${files[0]} does not match its own content digest; re-run \`bun run fonts:build\``)
    }
    const size = readFileSync(path).length
    total += size
    rows.push(`  ${label(face)}  ${(size / 1024).toFixed(1)} kB  ${found}  ${files[0]}`)
  }
  console.log(`fonts: ${FACES.length} committed Satoshi faces in public/fonts (${(total / 1024).toFixed(1)} kB)`)
  console.log(rows.join('\n'))
}

if (import.meta.main) {
  if (process.argv.includes('--check')) check()
  else build()
}