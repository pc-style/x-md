/**
 * The `/.well-known/agent-skills/index.json` catalog.
 *
 * Blume publishes the skill as a single `archive` entry pointing at a
 * `.tar.gz`. That is installable but not *readable*: an agent choosing between
 * tools, or a crawler looking for when-to-use guidance, cannot open a gzipped
 * tarball, so everything the skill says about itself is invisible until someone
 * commits to downloading it. Publishing the same `SKILL.md` as a plain
 * `skill-md` entry alongside the archive makes the guidance legible in one GET.
 *
 * Entries carry a `type`, a `url`, and a `digest` computed from the artifact's
 * raw bytes, per the v0.2.0 discovery schema.
 */

import { createHash } from 'node:crypto'

export const AGENT_SKILLS_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

export interface SkillEntry {
  name: string
  description: string
  type: 'skill-md' | 'archive'
  url: string
  digest: string
}

export interface SkillIndex {
  $schema?: string
  skills: SkillEntry[]
}

/** `sha256:<64 lowercase hex>` over the artifact's raw bytes. */
export function digestOf(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** The `description` an agent sees in the catalog, taken from the skill's own frontmatter. */
export function frontmatterDescription(skillMd: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd)
  if (!frontmatter) return undefined
  // A folded or quoted value is out of scope: the skill keeps it on one line.
  const described = /^description:[ \t]*(.+)$/m.exec(frontmatter[1] ?? '')
  return described?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined
}

/**
 * Add (or refresh) the readable `skill-md` entry for a skill, leaving every
 * other entry — notably blume's archive entry and its digest — untouched.
 */
export function withSkillMd(
  index: SkillIndex,
  skill: { name: string; description: string; url: string; source: string },
): SkillIndex {
  const entry: SkillEntry = {
    name: skill.name,
    description: skill.description,
    type: 'skill-md',
    url: skill.url,
    digest: digestOf(skill.source),
  }
  const kept = (index.skills ?? []).filter((existing) => !(existing.type === 'skill-md' && existing.url === entry.url))
  return {
    ...index,
    $schema: index.$schema ?? AGENT_SKILLS_SCHEMA,
    // Readable first: a client that reads one entry should get the legible one.
    skills: [entry, ...kept],
  }
}

/** Every entry a v0.2.0 consumer must be able to rely on. */
export function invalidEntries(index: SkillIndex): string[] {
  const problems: string[] = []
  for (const entry of index.skills ?? []) {
    const label = entry.name || entry.url || '(unnamed)'
    if (entry.type !== 'skill-md' && entry.type !== 'archive') problems.push(`${label}: type must be skill-md or archive`)
    if (!entry.url) problems.push(`${label}: missing url`)
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.digest ?? '')) problems.push(`${label}: digest must be sha256:<64 lowercase hex>`)
    if (!entry.description) problems.push(`${label}: missing description`)
  }
  return problems
}
