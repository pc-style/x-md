import { describe, expect, test } from 'vitest'
import { renderThreadMarkdown } from './markdown.js'
import article from './fixtures/article-rich-text.json'
import type { FxArticle } from './fxtwitter.js'

function render(value: FxArticle = article, format: 'markdown' | 'obsidian' = 'markdown') {
  return renderThreadMarkdown([{ article: value }], { format, userinfo: 'off', canonicalUrl: 'https://x.com/pcstyle53/status/2104241977772343534' })
}

describe('article rich text', () => {
  // Selected, unmodified blocks from the reported article's FxTwitter response.
  test.each(['markdown', 'obsidian'] as const)('preserves the reported article in %s output', format => {
    const output = render(article, format)
    expect(output).toContain('![cover](https://pbs.twimg.com/media/HTOWeQ7WgAAdLdF.png)')
    expect(output).toContain('![image](https://pbs.twimg.com/media/HTOWp8cXoAE7LNe.jpg)')
    expect(output).toContain('[full postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues)')
    expect(output).toContain('[put it well](https://x.com/theo/status/2103949446329532862)')
    expect(output).toContain('> We never reduce model quality due to demand, time of day, or server load.')
    expect(output).toContain('**the math.** theo')
    expect(output).toContain('- look at your effort setting')
    expect(output).toContain('- check your harness version and what changed in it')
    expect(output.indexOf('![image]')).toBeGreaterThan(output.indexOf('[put it well]'))
    expect(output.indexOf('![image]')).toBeLessThan(output.indexOf('- look at'))
  })
})

test('keeps UTF-16 offsets, link labels and nested styles intact', () => {
  expect(render({ content: {
    blocks: [{ text: '😀 Read [this] now.', entityRanges: [{ offset: 3, length: 11, key: 9 }], inlineStyleRanges: [
      { offset: 3, length: 11, style: 'Bold' }, { offset: 8, length: 6, style: 'Italic' },
    ] }],
    entityMap: [{ key: '9', value: { type: 'LINK', data: { url: 'https://example.com/a(b)' } } }],
  } })).toContain('😀 [**Read *\\[this\\]***](https://example.com/a%28b%29) now.')
})

test('retains text for missing entities and rejects unsafe link destinations', () => {
  expect(render({ content: {
    blocks: [{ text: 'Read this', entityRanges: [{ offset: 0, length: 4, key: 0 }, { offset: 5, length: 4, key: 1 }], inlineStyleRanges: [{ offset: -1, length: 9, style: 'Bold' }] }],
    entityMap: [{ key: '1', value: { type: 'LINK', data: { url: 'javascript:alert(1)' } } }],
  } })).toContain('Read this')
})

test('renders multiline quotes and list continuations with inline emphasis', () => {
  const output = render({ content: { blocks: [
    { type: 'header-three', text: 'Heading' },
    { type: 'blockquote', text: 'One\nTwo' },
    { type: 'ordered-list-item', text: 'First\ncontinued' },
    { type: 'unordered-list-item', depth: 1, text: 'Nested' },
    { text: ' old ', inlineStyleRanges: [{ offset: 0, length: 5, style: 'Strikethrough' }] },
  ] } })
  expect(output).toContain('### Heading')
  expect(output).toContain('> One\n> Two')
  expect(output).toContain('1. First\n   continued')
  expect(output).toContain('    - Nested')
  expect(output).toContain('~~old~~')
})
