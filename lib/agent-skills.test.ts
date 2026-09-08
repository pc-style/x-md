import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { AGENT_SKILLS_SCHEMA, digestOf, frontmatterDescription, invalidEntries, withSkillMd, type SkillIndex } from './agent-skills'

const SKILL = readFileSync('skills/browse-x/SKILL.md', 'utf8')

/** What blume emits before the catalog is patched: the archive, and nothing readable. */
const blumeIndex = (): SkillIndex => ({
  $schema: AGENT_SKILLS_SCHEMA,
  skills: [
    {
      name: 'browse-x',
      description: 'from frontmatter',
      type: 'archive',
      url: '/.well-known/agent-skills/browse-x.tar.gz',
      digest: `sha256:${'a'.repeat(64)}`,
    },
  ],
})

const patched = () =>
  withSkillMd(blumeIndex(), {
    name: 'browse-x',
    description: frontmatterDescription(SKILL) ?? '',
    url: '/.well-known/agent-skills/browse-x.md',
    source: SKILL,
  })

describe('digestOf', () => {
  test('is sha256 over the raw bytes, lowercase hex', () => {
    expect(digestOf('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(digestOf(new TextEncoder().encode('abc'))).toBe(digestOf('abc'))
  })
})

describe('frontmatterDescription', () => {
  test('reads the description the catalog will show', () => {
    expect(frontmatterDescription('---\nname: x\ndescription: Hello there\n---\nbody')).toBe('Hello there')
  })

  test('strips surrounding quotes and tolerates no frontmatter', () => {
    expect(frontmatterDescription('---\ndescription: "Quoted"\n---\n')).toBe('Quoted')
    expect(frontmatterDescription('no frontmatter here')).toBeUndefined()
    expect(frontmatterDescription('---\nname: x\n---\n')).toBeUndefined()
  })
})

describe('withSkillMd', () => {
  test('adds a readable entry without disturbing the archive', () => {
    const before = blumeIndex()
    const after = patched()
    const archive = after.skills.find((s) => s.type === 'archive')
    expect(archive).toEqual(before.skills[0])
    expect(after.skills).toHaveLength(2)
  })

  test('the readable entry comes first and carries the source digest', () => {
    const after = patched()
    expect(after.skills[0]?.type).toBe('skill-md')
    expect(after.skills[0]?.url).toBe('/.well-known/agent-skills/browse-x.md')
    expect(after.skills[0]?.digest).toBe(digestOf(SKILL))
  })

  test('is idempotent, so a rebuild never stacks duplicates', () => {
    const once = patched()
    const twice = withSkillMd(once, {
      name: 'browse-x',
      description: frontmatterDescription(SKILL) ?? '',
      url: '/.well-known/agent-skills/browse-x.md',
      source: SKILL,
    })
    expect(twice.skills).toEqual(once.skills)
  })

  test('keeps the v0.2.0 $schema when the input already declares one', () => {
    expect(patched().$schema).toBe(AGENT_SKILLS_SCHEMA)
    expect(withSkillMd({ skills: [] }, { name: 'a', description: 'd', url: '/a.md', source: 'x' }).$schema).toBe(AGENT_SKILLS_SCHEMA)
  })
})

describe('invalidEntries', () => {
  test('accepts the patched catalog', () => {
    expect(invalidEntries(patched())).toEqual([])
  })

  test('names every way an entry can fail the schema', () => {
    const problems = invalidEntries({
      skills: [
        { name: 'bad-type', description: 'd', type: 'tarball' as 'archive', url: '/a', digest: `sha256:${'b'.repeat(64)}` },
        { name: 'no-url', description: 'd', type: 'archive', url: '', digest: `sha256:${'b'.repeat(64)}` },
        { name: 'bad-digest', description: 'd', type: 'archive', url: '/a', digest: 'sha256:SHORT' },
        { name: 'no-description', description: '', type: 'archive', url: '/a', digest: `sha256:${'b'.repeat(64)}` },
      ],
    })
    expect(problems).toHaveLength(4)
    expect(problems.join('\n')).toContain('type must be skill-md or archive')
    expect(problems.join('\n')).toContain('missing url')
    expect(problems.join('\n')).toContain('digest must be sha256:<64 lowercase hex>')
    expect(problems.join('\n')).toContain('missing description')
  })

  test('an uppercase digest is rejected, since the spec says lowercase hex', () => {
    const problems = invalidEntries({
      skills: [{ name: 'x', description: 'd', type: 'archive', url: '/a', digest: `sha256:${'A'.repeat(64)}` }],
    })
    expect(problems).toHaveLength(1)
  })
})

describe('the published skill description', () => {
  test('is within the 1024-character limit the Agent Skills spec sets', () => {
    const description = frontmatterDescription(SKILL) ?? ''
    expect(description.length).toBeGreaterThan(0)
    expect(description.length).toBeLessThanOrEqual(1024)
  })

  test('says when to reach for the skill, not just what it does', () => {
    const description = (frontmatterDescription(SKILL) ?? '').toLowerCase()
    expect(description).toContain('use when')
    // The trigger keywords an agent matches a prompt against.
    for (const keyword of ['x.com', 'twitter.com', 't.co', 'profile', 'thread']) {
      expect(description).toContain(keyword)
    }
    // And the boundary, so an agent does not reach for it to write.
    expect(description).toContain('read-only')
  })

  test('a description containing ": " is quoted, or the YAML frontmatter will not parse', () => {
    // An unquoted YAML scalar cannot contain ": ". Blume parses this frontmatter
    // to build the catalog and skips the skill silently when it fails, which
    // takes /.well-known/agent-skills/ off the site entirely.
    const raw = /^description:[ \t]*(.+)$/m.exec(SKILL)?.[1] ?? ''
    const quoted = /^".*"$/.test(raw) || /^'.*'$/.test(raw)
    if (raw.includes(': ')) expect(quoted).toBe(true)
  })

  test('the skill body keeps its when-to-use and when-not-to-use sections', () => {
    expect(SKILL.toLowerCase()).toContain('## when to use this')
    expect(SKILL.toLowerCase()).toContain('## when not to use this')
  })
})
