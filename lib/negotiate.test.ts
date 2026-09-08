import { describe, expect, test } from 'vitest'
import { mediaQuality, notAcceptableBody, parseAccept, selectRepresentation, type Repr } from './negotiate'

const PAGE: Repr[] = ['html', 'markdown']

describe('parseAccept', () => {
  test('reads q-values and defaults to 1', () => {
    expect(parseAccept('text/markdown, text/html;q=0.8')).toEqual([
      { type: 'text', sub: 'markdown', q: 1 },
      { type: 'text', sub: 'html', q: 0.8 },
    ])
  })

  test('clamps out-of-range q-values', () => {
    expect(parseAccept('text/html;q=9')[0]?.q).toBe(1)
    expect(parseAccept('text/html;q=-3')[0]?.q).toBe(0)
  })
})

describe('selectRepresentation', () => {
  test('an explicit markdown request wins', () => {
    expect(selectRepresentation('text/markdown', PAGE, 'html')).toBe('markdown')
  })

  test('higher q wins over the fallback', () => {
    expect(selectRepresentation('text/markdown, text/html;q=0.8', PAGE, 'html')).toBe('markdown')
  })

  test('an explicit html request stays html', () => {
    expect(selectRepresentation('text/html', PAGE, 'html')).toBe('html')
  })

  test('q=0 rejects a representation instead of matching it', () => {
    expect(selectRepresentation('text/markdown;q=0, text/html', PAGE, 'html')).toBe('html')
  })

  test('q=0 on the only offer is 406', () => {
    expect(selectRepresentation('text/markdown;q=0', ['markdown'], 'markdown')).toBeNull()
  })

  test('a missing Accept serves the default', () => {
    expect(selectRepresentation(undefined, PAGE, 'html')).toBe('html')
    expect(selectRepresentation('', PAGE, 'html')).toBe('html')
  })

  test('*/* serves the default rather than the first offer', () => {
    expect(selectRepresentation('*/*', PAGE, 'html')).toBe('html')
    expect(selectRepresentation('*/*', ['markdown', 'json'], 'markdown')).toBe('markdown')
  })

  test('a real browser header resolves to html', () => {
    const chrome =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7'
    expect(selectRepresentation(chrome, PAGE, 'html')).toBe('html')
  })

  test('an unmatched type is 406', () => {
    expect(selectRepresentation('application/pdf', PAGE, 'html')).toBeNull()
  })

  test('text/* matches the text offers and keeps the default', () => {
    expect(selectRepresentation('text/*', PAGE, 'html')).toBe('html')
    expect(selectRepresentation('text/*', ['markdown', 'json'], 'markdown')).toBe('markdown')
  })

  test('text/* is no preference between text offers, so the default wins', () => {
    // Naming no concrete type must not hand the caller whichever offer is
    // listed first: an agent sending text/* gets the resource's own default.
    expect(selectRepresentation('text/*', PAGE, 'markdown')).toBe('markdown')
    expect(selectRepresentation('text/*', ['html', 'markdown', 'json'], 'markdown')).toBe('markdown')
  })

  test('text/* keeps the first match when the default is not a text type', () => {
    expect(selectRepresentation('text/*', ['html', 'markdown', 'json'], 'json')).toBe('html')
  })

  test('a concrete type outranks the wildcard that covers the default', () => {
    expect(selectRepresentation('text/*;q=0.9, text/html;q=0.5', PAGE, 'html')).toBe('markdown')
    expect(selectRepresentation('text/*, text/html', PAGE, 'markdown')).toBe('html')
  })

  test('a subtype wildcard does not match a different type', () => {
    expect(selectRepresentation('text/*', ['json'], 'json')).toBeNull()
  })
})

describe('mediaQuality', () => {
  test('reports the q of a named type and marks it exact', () => {
    expect(mediaQuality('application/json;q=0.4, text/event-stream', 'text/event-stream')).toEqual({ q: 1, exact: true })
    expect(mediaQuality('application/json;q=0.4', 'application/json')).toEqual({ q: 0.4, exact: true })
  })

  test('an explicit rejection reports q=0 rather than no match', () => {
    expect(mediaQuality('text/event-stream;q=0, application/json', 'text/event-stream')).toEqual({ q: 0, exact: true })
  })

  test('a wildcard match is not exact', () => {
    expect(mediaQuality('*/*', 'application/problem+json')).toEqual({ q: 1, exact: false })
    expect(mediaQuality('text/*', 'text/event-stream')).toEqual({ q: 1, exact: false })
  })

  test('an absent header and an unmatched type are both null', () => {
    expect(mediaQuality('', 'application/json')).toBeNull()
    expect(mediaQuality(undefined, 'application/json')).toBeNull()
    expect(mediaQuality('text/html', 'application/json')).toBeNull()
  })

  test('media type matching is case-insensitive', () => {
    expect(mediaQuality('Text/Event-Stream', 'text/event-stream')).toEqual({ q: 1, exact: true })
  })
})

describe('notAcceptableBody', () => {
  test('lists every offered media type', () => {
    const body = notAcceptableBody(PAGE, 'application/pdf')
    expect(body).toContain('text/html')
    expect(body).toContain('text/markdown')
    expect(body).toContain('You requested: application/pdf')
  })
})
