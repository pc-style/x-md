import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApiKey, touchApiKey, updateApiKey } from './apikeys.js'
import { resetKv } from './kv.js'
import { clampIdle, getPoolSettings, poolSnapshot, reservationFor, resetPool, setPoolSettings } from './pool.js'
import { rateLimit, resetRateLimits } from './ratelimit.js'

const W = 900
const HOUR = 3_600_000
const NOW = new Date('2026-09-07T12:00:00Z').getTime() // exactly on a 15-minute boundary

beforeEach(() => {
  resetKv()
  resetRateLimits()
  resetPool()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('reservationFor', () => {
  const base = { limit: 60, disabled: false, used: 0, previousUsed: 0, lastUsedAt: NOW }

  test('an active key at window start holds its full allowance', () => {
    expect(reservationFor(base, { elapsedSec: 0, remainingSec: W }, W, HOUR, NOW)).toEqual({ reserved: 60, idle: false })
  })

  test('idle and disabled keys hold nothing', () => {
    expect(reservationFor({ ...base, lastUsedAt: NOW - 2 * HOUR }, { elapsedSec: 0, remainingSec: W }, W, HOUR, NOW)).toEqual({ reserved: 0, idle: true })
    expect(reservationFor({ ...base, lastUsedAt: undefined }, { elapsedSec: 0, remainingSec: W }, W, HOUR, NOW).reserved).toBe(0)
    expect(reservationFor({ ...base, disabled: true }, { elapsedSec: 0, remainingSec: W }, W, HOUR, NOW)).toEqual({ reserved: 0, idle: false })
  })

  test('an unused allowance decays toward zero as the window runs out', () => {
    // 14 of 15 minutes gone, nothing used, no pace: hold only 1/15 of the allowance.
    expect(reservationFor(base, { elapsedSec: 840, remainingSec: 60 }, W, HOUR, NOW).reserved).toBe(4)
    expect(reservationFor(base, { elapsedSec: 900, remainingSec: 0 }, W, HOUR, NOW).reserved).toBe(0)
  })

  test('observed pace projects higher than time decay and is capped at what remains', () => {
    // 20 used in the first 5 minutes → 4/min; 10 minutes left → 40 × 2 safety = 80 > remaining 40.
    expect(reservationFor({ ...base, used: 20 }, { elapsedSec: 300, remainingSec: 600 }, W, HOUR, NOW).reserved).toBe(40)
    // Late in the window, a slow pace still beats pure decay: 2 used in 12 min, 3 min left → ceil(2/720×180×2)=1 vs ceil(58×180/900)=12.
    expect(reservationFor({ ...base, used: 2 }, { elapsedSec: 720, remainingSec: 180 }, W, HOUR, NOW).reserved).toBe(12)
    // Previous-window usage counts as pace for a key that has not started this window yet.
    expect(reservationFor({ ...base, previousUsed: 45 }, { elapsedSec: 840, remainingSec: 60 }, W, HOUR, NOW).reserved).toBe(6)
  })
})

describe('pool settings', () => {
  test('defaults to 60 idle minutes and clamps saved values', async () => {
    expect((await getPoolSettings()).idleReleaseMinutes).toBe(60)
    expect(clampIdle(5)).toBe(15)
    expect(clampIdle(100_000)).toBe(1440)
    await setPoolSettings({ idleReleaseMinutes: 30 })
    expect((await getPoolSettings()).idleReleaseMinutes).toBe(30)
  })
})

describe('poolSnapshot', () => {
  test('public cap is pool minus key usage and live reservations', async () => {
    const alice = await createApiKey('alice', 60)
    const bob = await createApiKey('bob', 30)
    await touchApiKey(alice.record) // active
    await updateApiKey(bob.record.id, { disabled: true })
    for (let i = 0; i < 10; i++) await rateLimit(`xsearch:key:${alice.record.id}`, 60, W)
    for (let i = 0; i < 7; i++) await rateLimit('xsearch:public', 1000, W)

    vi.setSystemTime(NOW + 300_000) // 5 minutes in
    const snap = await poolSnapshot(200, W)
    expect(snap).toMatchObject({ capacity: 200, windowElapsedSec: 300, windowRemainingSec: 600, keysUsed: 10, publicUsed: 7 })
    // alice: 10 used in 300s → pace 1/30s → 600s × 2 = 40 projected; remaining 50; hold 40.
    expect(snap.keys.find((k) => k.id === alice.record.id)).toMatchObject({ used: 10, reserved: 40, idle: false })
    expect(snap.keys.find((k) => k.id === bob.record.id)).toMatchObject({ used: 0, reserved: 0 })
    expect(snap.keysReserved).toBe(40)
    expect(snap.publicCap).toBe(150)
    expect(snap.publicRemaining).toBe(143)
  })

  test('idle keys release everything to the public and the snapshot is cached briefly', async () => {
    const { record } = await createApiKey('carol', 80)
    await touchApiKey(record, NOW - 3 * HOUR)
    expect((await poolSnapshot(100, W)).publicCap).toBe(100)
    await touchApiKey(record, NOW) // becomes active, but cache still serves the old split for a few seconds
    expect((await poolSnapshot(100, W)).publicCap).toBe(100)
    resetPool()
    expect((await poolSnapshot(100, W)).publicCap).toBe(20)
  })
})
