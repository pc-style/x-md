import { describe, expect, test } from 'vitest'
import { cursorAt, decodeTimelineCursor, encodeTimelineCursor, parseDateInput, snowflakeAt, snowflakeTime } from './fx-cursor.js'

// Real cursors returned by api.fxtwitter.com for /2/profile/paulg/statuses.
const TOP = 'DAAHCgABHRyg62bAJxELAAIAAAATMjA5NzY5OTk5NTIzMTA4NDkwMQgAAwAAAAEAAA'
const BOTTOM = 'DAAHCgABHRyg62a__-8LAAIAAAATMjA5NzM5NzkzMDA4ODkzNTcwNQgAAwAAAAIAAA'

describe('timeline cursors', () => {
  test('decodes the Thrift struct X mints', () => {
    expect(decodeTimelineCursor(BOTTOM)).toEqual({ issuedAt: 2097728459349426159n, sortIndex: 2097397930088935705n, direction: 2 })
    expect(decodeTimelineCursor(TOP)).toEqual({ issuedAt: 2097728459349436177n, sortIndex: 2097699995231084901n, direction: 1 })
  })

  test('round-trips byte for byte', () => {
    for (const cursor of [TOP, BOTTOM]) expect(encodeTimelineCursor(decodeTimelineCursor(cursor)!)).toBe(cursor)
  })

  test('rejects foreign strings', () => {
    expect(decodeTimelineCursor('xsearch:abc')).toBeUndefined()
    expect(decodeTimelineCursor('')).toBeUndefined()
    expect(decodeTimelineCursor('not base64 at all!')).toBeUndefined()
  })

  test('forges a bottom cursor whose sort index sits at the requested instant', () => {
    const at = Date.UTC(2026, 5, 1)
    const decoded = decodeTimelineCursor(cursorAt(at, Date.UTC(2026, 8, 9)))!
    expect(decoded.direction).toBe(2)
    expect(snowflakeTime(decoded.sortIndex)).toBe(at)
    expect(decoded.issuedAt & 0xffffn).toBe(0xffefn)
    expect(snowflakeTime(decoded.issuedAt & ~0xffffn)).toBeLessThanOrEqual(Date.UTC(2026, 8, 9))
  })

  test('snowflake helpers agree with a known id', () => {
    expect(snowflakeTime('2097354282609566046')).toBe(Date.UTC(2026, 8, 8, 16, 0, 2, 589))
    expect(snowflakeTime(snowflakeAt(1_700_000_000_000))).toBe(1_700_000_000_000)
  })

  test('parses date inputs', () => {
    expect(parseDateInput('2025-01-01')?.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(parseDateInput('2025-01-01T12:30:00Z')?.toISOString()).toBe('2025-01-01T12:30:00.000Z')
    expect(parseDateInput('1700000000')?.getTime()).toBe(1_700_000_000_000)
    expect(parseDateInput('1700000000000')?.getTime()).toBe(1_700_000_000_000)
    expect(parseDateInput('2025-01-01T12:30:00+02:00')?.toISOString()).toBe('2025-01-01T10:30:00.000Z')
    expect(parseDateInput('yesterday')).toBeUndefined()
    expect(parseDateInput('Jan 1 2025')).toBeUndefined()
    expect(parseDateInput('2025-13-45')).toBeUndefined()
    expect(parseDateInput('')).toBeUndefined()
  })
})
