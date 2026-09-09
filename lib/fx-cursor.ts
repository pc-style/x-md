/**
 * X timeline cursors, decoded.
 *
 * FxTwitter passes X's own `UserTweets` cursors through untouched. They are
 * URL-safe base64 of a Thrift **binary** struct:
 *
 *   struct { 7: struct { 1: i64 issuedAt; 2: string sortIndex; 3: i32 direction } }
 *
 * `issuedAt` is a snowflake for the moment X minted the cursor, `sortIndex` is
 * the snowflake the next page starts below (bottom) or above (top), and
 * `direction` is 1 for top and 2 for bottom. Because the sort index is a plain
 * snowflake, a cursor can be *forged* for any instant: X answers it with the
 * page that starts just before that moment. That turns the strictly sequential
 * cursor chain into as many independent chains as we like (lib/import.ts).
 */

const TWEPOCH = 1288834974657n

export interface TimelineCursor {
  issuedAt: bigint
  sortIndex: bigint
  direction: 1 | 2
}

/** Snowflake id whose timestamp is `ms` (worker/sequence bits zero). */
export function snowflakeAt(ms: number): bigint {
  return (BigInt(Math.max(0, Math.floor(ms))) - TWEPOCH) << 22n
}

/** Millisecond timestamp encoded in a snowflake id. */
export function snowflakeTime(id: bigint | string | number): number {
  return Number((BigInt(id) >> 22n) + TWEPOCH)
}

function fromUrlSafe(cursor: string): Uint8Array {
  const padded = cursor.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (cursor.length % 4)) % 4)
  return new Uint8Array(Buffer.from(padded, 'base64'))
}

function toUrlSafe(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function decodeTimelineCursor(cursor: string): TimelineCursor | undefined {
  try {
    const b = fromUrlSafe(cursor)
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength)
    if (b[0] !== 0x0c || view.getUint16(1) !== 7) return undefined
    let i = 3
    let issuedAt: bigint | undefined
    let sortIndex: bigint | undefined
    let direction: number | undefined
    while (i < b.length && b[i] !== 0) {
      const type = b[i]
      const field = view.getUint16(i + 1)
      i += 3
      if (type === 0x0a) {
        if (field === 1) issuedAt = view.getBigInt64(i)
        i += 8
      } else if (type === 0x0b) {
        const length = view.getUint32(i)
        const text = Buffer.from(b.subarray(i + 4, i + 4 + length)).toString('utf8')
        if (field === 2) sortIndex = BigInt(text)
        i += 4 + length
      } else if (type === 0x08) {
        if (field === 3) direction = view.getInt32(i)
        i += 4
      } else {
        return undefined
      }
    }
    if (issuedAt === undefined || sortIndex === undefined || (direction !== 1 && direction !== 2)) return undefined
    return { issuedAt, sortIndex, direction }
  } catch {
    return undefined
  }
}

export function encodeTimelineCursor(cursor: TimelineCursor): string {
  const sort = Buffer.from(cursor.sortIndex.toString(), 'utf8')
  const out = Buffer.alloc(3 + 3 + 8 + 3 + 4 + sort.length + 3 + 4 + 2)
  let i = 0
  out[i++] = 0x0c; out.writeUInt16BE(7, i); i += 2
  out[i++] = 0x0a; out.writeUInt16BE(1, i); i += 2; out.writeBigInt64BE(cursor.issuedAt, i); i += 8
  out[i++] = 0x0b; out.writeUInt16BE(2, i); i += 2; out.writeUInt32BE(sort.length, i); i += 4; sort.copy(out, i); i += sort.length
  out[i++] = 0x08; out.writeUInt16BE(3, i); i += 2; out.writeInt32BE(cursor.direction, i); i += 4
  out[i++] = 0; out[i++] = 0
  return toUrlSafe(new Uint8Array(out))
}

/**
 * A bottom cursor that makes the timeline start just before `at`. X mints real
 * bottom cursors with the low 16 bits of `issuedAt` set to `0xffef`; we copy that.
 */
export function cursorAt(at: Date | number, now = Date.now()): string {
  const ms = at instanceof Date ? at.getTime() : at
  return encodeTimelineCursor({
    issuedAt: (snowflakeAt(now) & ~0xffffn) | 0xffefn,
    sortIndex: snowflakeAt(ms),
    direction: 2,
  })
}

/** Parse `since`/`until` style inputs: ISO dates, ISO datetimes, or unix seconds/ms. */
export function parseDateInput(value: string | null | undefined): Date | undefined {
  const raw = (value ?? '').trim()
  if (!raw) return undefined
  if (/^\d{9,13}$/.test(raw)) {
    const n = Number(raw)
    return new Date(raw.length <= 10 ? n * 1000 : n)
  }
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date
}
