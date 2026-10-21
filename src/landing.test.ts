import { expect, test } from 'vitest'
import { GRADIENTS } from './gradients'
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
  // The post as x.com shows it is a decorative double of the Markdown.
  expect(card).toMatch(/<div class="post-view" aria-hidden="true">/)
})

test('the closing name ships whole, one box per typed letter', () => {
  const mark = html.match(/<p class="host-mark" aria-hidden="true">[\s\S]*?<\/p>/)![0]
  expect(text(mark)).toBe('mdfromx.com')
  expect([...mark.matchAll(/<span style="--i:(\d)">/g)].map(match => Number(match[1]))).toEqual([0, 1, 2, 3, 4, 5])
})

test('every live gradient names a preset, and every sky but the aurora paints its stand-in without JavaScript', () => {
  const names = [...html.matchAll(/<canvas class="gradient-canvas[^"]*" data-gradient="([a-z]+)"/g)].map(match => match[1])
  expect(names).toEqual(['orbit', 'aurora', 'mark', 'eclipse', 'glass', 'dawn', 'name'])
  for (const name of names) expect(GRADIENTS).toHaveProperty(name)
  const skies = [...html.matchAll(/<div class="([a-z]+)-sky" style="background: [^"]+" aria-hidden="true">\s*<canvas class="gradient-canvas" data-gradient="([a-z]+)">/g)]
  // The aurora is extra light over the arc's stand-in, with none of its own.
  expect(skies.map(match => match[2])).toEqual(['orbit', 'eclipse', 'glass', 'dawn'])
  expect(html).toMatch(/<div class="aurora-sky" aria-hidden="true">/)
})

test('the headline reads the same with its word in chrome', () => {
  const headline = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1]
  expect(text(headline).replace(/\s+/g, ' ').trim()).toBe('Tweets are just markdown now.')
  expect(headline).toContain('data-gradient="mark" aria-hidden="true"')
})

test('every "what comes through" panel is in the markup, stacked, with the tablist hidden until tabs.ts runs', () => {
  expect(html).toMatch(/<div role="tablist"[^>]*\bhidden>/)
  const panels = [...html.matchAll(/<div id="panel-([a-z]+)" class="tab-panel spot">/g)].map(match => match[1])
  expect(panels).toEqual(['threads', 'media', 'quotes', 'articles', 'obsidian'])
  for (const id of panels) expect(html).toContain(`aria-controls="panel-${id}"`)
})
