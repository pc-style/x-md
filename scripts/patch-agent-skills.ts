/**
 * Publish the skill's `SKILL.md` next to the archive blume generates, and list
 * it in the catalog as a readable `skill-md` entry.
 *
 * Runs after `vite build`, because blume writes the catalog during `docs:build`
 * and Vite copies `public/` over `dist/` afterwards. Only the `skill-md` entry
 * is touched; the archive entry and its digest stay exactly as blume computed
 * them.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { frontmatterDescription, invalidEntries, withSkillMd, type SkillIndex } from '../lib/agent-skills.js'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE = resolve(ROOT, 'skills/browse-x/SKILL.md')
const CATALOG = resolve(ROOT, 'dist/.well-known/agent-skills/index.json')
const PUBLISHED = resolve(ROOT, 'dist/.well-known/agent-skills/browse-x.md')
const URL_PATH = '/.well-known/agent-skills/browse-x.md'

async function main(): Promise<void> {
  const source = await readFile(SOURCE, 'utf8')
  const description = frontmatterDescription(source)
  if (!description) throw new Error(`${SOURCE} has no frontmatter description`)

  let index: SkillIndex
  try {
    index = JSON.parse(await readFile(CATALOG, 'utf8')) as SkillIndex
  } catch {
    throw new Error(`${CATALOG} is missing — run the docs build before this script`)
  }

  await mkdir(dirname(PUBLISHED), { recursive: true })
  await writeFile(PUBLISHED, source)

  const patched = withSkillMd(index, { name: 'browse-x', description, url: URL_PATH, source })
  const problems = invalidEntries(patched)
  if (problems.length) throw new Error(`agent-skills catalog is not v0.2.0 conformant:\n  ${problems.join('\n  ')}`)

  await writeFile(CATALOG, `${JSON.stringify(patched, null, 2)}\n`)
  console.log(`agent-skills: published ${URL_PATH} and listed ${patched.skills.length} entries`)
}

await main()
