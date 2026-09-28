import { describe, expect, it } from 'vitest'
import { JobLog, Jobs } from './jobs.ts'

describe('JobLog', () => {
  it('returns what is already logged without waiting', async () => {
    const log = new JobLog<number>()
    log.push(1)
    log.push(2)
    const started = Date.now()
    expect(await log.read(0, 5000)).toEqual({ events: [1, 2], next: 2, closed: false })
    expect(await log.read(1, 5000)).toEqual({ events: [2], next: 2, closed: false })
    expect(Date.now() - started).toBeLessThan(100)
  })

  it('wakes a waiting reader as soon as an event lands', async () => {
    const log = new JobLog<string>()
    const started = Date.now()
    const pending = log.read(0, 5000)
    setTimeout(() => log.push('x'), 30)
    expect(await pending).toEqual({ events: ['x'], next: 1, closed: false })
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('answers empty after the timeout, and reports closed once drained', async () => {
    const log = new JobLog<string>()
    expect(await log.read(0, 20)).toEqual({ events: [], next: 0, closed: false })
    log.push('last')
    log.close()
    log.push('ignored')
    expect(await log.read(0, 20)).toEqual({ events: ['last'], next: 1, closed: true })
  })
})

describe('Jobs', () => {
  it('aborts and forgets jobs nobody polls', () => {
    const jobs = new Jobs<number>(1000)
    const { id, log } = jobs.create()
    expect(jobs.get(id)).toBe(log)
    jobs.sweep(log.lastRead + 500)
    expect(jobs.get(id)).toBe(log)
    jobs.sweep(log.lastRead + 1500)
    expect(jobs.get(id)).toBeUndefined()
    expect(log.controller.signal.aborted).toBe(true)
  })
})
