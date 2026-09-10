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
const CATALOG = resolve(ROOT, 'dist/.well-known/agent-skills/index.json')
/** Every skill under skills/ that ships as readable Markdown. Listed readable-first, so the last one here is first in the catalog. */
const SKILLS = ['browse-x', 'import-x-history']

async function main(): Promise<void> {
  let index: SkillIndex
  try {
    index = JSON.parse(await readFile(CATALOG, 'utf8')) as SkillIndex
  } catch {
    throw new Error(`${CATALOG} is missing — run the docs build before this script`)
  }

  const published: string[] = []
  for (const name of SKILLS) {
    const sourcePath = resolve(ROOT, `skills/${name}/SKILL.md`)
    const source = await readFile(sourcePath, 'utf8')
    const description = frontmatterDescription(source)
    if (!description) throw new Error(`${sourcePath} has no frontmatter description`)
    const urlPath = `/.well-known/agent-skills/${name}.md`
    const target = resolve(ROOT, `dist${urlPath}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source)
    index = withSkillMd(index, { name, description, url: urlPath, source })
    published.push(urlPath)
  }

  const problems = invalidEntries(index)
  if (problems.length) throw new Error(`agent-skills catalog is not v0.2.0 conformant:\n  ${problems.join('\n  ')}`)

  await writeFile(CATALOG, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`agent-skills: published ${published.join(', ')} and listed ${index.skills.length} entries`)
}

await main()
