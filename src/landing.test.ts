import { expect, test } from 'vitest'
import { landingHtml } from './landing'

const html = landingHtml()
/** The visible text of trusted, prerendered markup: the segments between tags, entities decoded. */
const text = (markup: string) =>
  markup
    .split(/<[^>]+>/)
    .join('')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')

test('streamed panes keep their exact text, one balanced box per line', () => {
  const panes = [...html.matchAll(/<pre[^>]*class="stream[^"]*"[^>]*>([\s\S]*?)<\/pre>/g)].map(match => match[1])
  expect(panes).toHaveLength(3)
  for (const pane of panes) {
    const lines = pane.split('\n')
    lines.forEach((line, i) => {
      expect(line.startsWith(`<span class="ln" style="--i:${i}">`)).toBe(true)
      expect(line.match(/<span\b/g)?.length).toBe(line.match(/<\/span>/g)?.length)
    })
  }
  expect(text(panes[0])).toBe(`## Post · 1/11 — Thariq (@trq212)

## Using Claude Code: The Unreasonable
   Effectiveness of HTML

![cover](https://pbs.twimg.com/…)

Markdown has become the dominant file
format used by agents to communicate
with us…`)
  expect(text(panes[1]).trim().endsWith('JavaScript is not available.')).toBe(true)
})

test('the hero card ships its finished state for readers without JavaScript or motion', () => {
  const card = html.match(/<div class="float-card hero-demo">[\s\S]*?<\/pre>/)![0]
  expect(text(card.match(/<span class="card-url">[\s\S]*?<\/span><\/span><\/span>/)![0])).toBe('mdfromx.com/trq212/status/2052809885763747935')
  expect(card).toContain('<span class="pane-tag pane-tag-bad card-tag-from" aria-hidden="true">text/html</span>')
})

test('every "what comes through" panel is in the markup, stacked, with the tablist hidden until tabs.ts runs', () => {
  expect(html).toMatch(/<div role="tablist"[^>]*\bhidden>/)
  const panels = [...html.matchAll(/<div id="panel-([a-z]+)" class="tab-panel">/g)].map(match => match[1])
  expect(panels).toEqual(['threads', 'media', 'quotes', 'articles', 'obsidian'])
  for (const id of panels) expect(html).toContain(`aria-controls="panel-${id}"`)
})
