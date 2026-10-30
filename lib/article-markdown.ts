import type { FxArticle, FxArticleBlock, FxArticleEntity } from './fxtwitter.js'

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<>~]/g, '\\$&')
}

function destination(value?: string): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined
  return value.replace(/[\s()<>\\]/g, char => encodeURIComponent(char).replace(/[()]/g, paren => `%${paren.charCodeAt(0).toString(16)}`))
}

interface Span { start: number; end: number; open: string; close: string }

function inlineText(block: FxArticleBlock, entities: Map<string, FxArticleEntity>): string {
  const text = block.text ?? ''
  const spans: Span[] = []
  function add(offset: number, length: number, open: string, close: string) {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length <= 0 || offset + length > text.length) return
    let start = offset
    let end = offset + length
    // Draft style ranges often include trailing spaces; Markdown delimiters cannot.
    while (start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (start < end) spans.push({ start, end, open, close })
  }
  for (const range of block.entityRanges ?? []) {
    const entity = entities.get(String(range.key))
    const url = entity?.type === 'LINK' ? destination(entity.data?.url) : undefined
    if (url) add(range.offset, range.length, '[', `](${url})`)
  }
  for (const range of block.inlineStyleRanges ?? []) {
    const style = range.style.toLowerCase()
    const marker = style === 'bold' ? '**' : style === 'italic' ? '*' : style === 'strikethrough' ? '~~' : undefined
    if (marker) add(range.offset, range.length, marker, marker)
  }
  // Keep enclosing formatting open when an inner link or style starts or ends.
  spans.sort((a, b) => a.start - b.start || b.end - a.end)
  const points = [...new Set([0, text.length, ...spans.flatMap(span => [span.start, span.end])])].sort((a, b) => a - b)
  let active: Span[] = []
  let result = ''
  for (let i = 0; i < points.length; i++) {
    const start = points[i]
    const next = spans.filter(span => span.start <= start && span.end > start)
    let shared = 0
    while (shared < active.length && active[shared] === next[shared]) shared++
    result += active.slice(shared).reverse().map(span => span.close).join('')
    result += next.slice(shared).map(span => span.open).join('')
    if (i + 1 < points.length) result += escapeText(text.slice(start, points[i + 1]))
    active = next
  }
  return result.trim()
}

export function articleToMarkdown(article: FxArticle): string[] {
  const lines: string[] = []
  if (article.title) lines.push(`## ${escapeText(article.title)}`, '')
  const cover = destination(article.cover_media?.media_info?.original_img_url)
  if (cover) lines.push(`![cover](${cover})`, '')

  // FxTwitter sends a keyed array, in no particular order, rather than Draft's object map.
  const entities = new Map((article.content?.entityMap ?? []).map(entry => [entry.key, entry.value]))
  const media = new Map((article.media_entities ?? []).map(item => [item.media_id, item]))
  for (const block of article.content?.blocks ?? []) {
    if (block.type === 'atomic') {
      for (const range of block.entityRanges ?? []) {
        const entity = entities.get(String(range.key))
        if (entity?.type !== 'MEDIA') continue
        for (const item of entity.data?.mediaItems ?? []) {
          const url = destination(media.get(item.mediaId)?.media_info?.original_img_url)
          if (url) lines.push(`![image](${url})`, '')
        }
      }
      continue
    }
    const text = inlineText(block, entities)
    if (!text) continue
    const heading = ['header-one', 'header-two', 'header-three', 'header-four', 'header-five', 'header-six'].indexOf(block.type ?? '')
    if (heading >= 0) lines.push(`${'#'.repeat(heading + 1)} ${text}`)
    else if (block.type === 'blockquote') lines.push(text.split('\n').map(line => `> ${line}`).join('\n'))
    else if (block.type === 'unordered-list-item' || block.type === 'ordered-list-item') {
      const indent = '    '.repeat(Math.min(10, Math.max(0, Math.trunc(block.depth ?? 0) || 0)))
      const marker = block.type === 'ordered-list-item' ? '1. ' : '- '
      lines.push(`${indent}${marker}${text.replace(/\n/g, `\n${indent}${' '.repeat(marker.length)}`)}`)
    } else lines.push(text)
    lines.push('')
  }
  if (lines.length === 0 && article.preview_text) lines.push(escapeText(article.preview_text), '')
  return lines
}
