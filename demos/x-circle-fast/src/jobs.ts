/**
 * An append-only event log per circle, read by long polling. Each poll returns
 * as soon as there is anything past the reader's cursor, so latency matches a
 * stream, but every response is complete: proxies that buffer streamed
 * responses (Cloudflare quick tunnels do) cannot hold events back.
 */
export class JobLog<Event> {
  readonly events: Event[] = []
  closed = false
  profilesRequested = 0
  lastRead = Date.now()
  readonly controller = new AbortController()
  private waiters: (() => void)[] = []

  push(event: Event) {
    if (this.closed) return
    this.events.push(event)
    this.wake()
  }

  close() {
    this.closed = true
    this.wake()
  }

  /** Events after `cursor`, waiting up to `timeoutMs` for the first one. */
  async read(cursor: number, timeoutMs: number): Promise<{ events: Event[]; next: number; closed: boolean }> {
    this.lastRead = Date.now()
    if (cursor >= this.events.length && !this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, timeoutMs)
        function done() { clearTimeout(timer); resolve() }
        this.waiters.push(done)
      })
      this.lastRead = Date.now()
    }
    const events = this.events.slice(cursor)
    return { events, next: cursor + events.length, closed: this.closed && cursor + events.length >= this.events.length }
  }

  private wake() {
    for (const wake of this.waiters.splice(0)) wake()
  }
}

export class Jobs<Event> {
  private readonly jobs = new Map<string, JobLog<Event>>()
  private readonly idleMs: number

  constructor(idleMs = 60_000) {
    this.idleMs = idleMs
    setInterval(() => this.sweep(), 10_000).unref?.()
  }

  create(): { id: string; log: JobLog<Event> } {
    const id = crypto.randomUUID()
    const log = new JobLog<Event>()
    this.jobs.set(id, log)
    return { id, log }
  }

  get(id: string): JobLog<Event> | undefined {
    return this.jobs.get(id)
  }

  /** A job nobody has polled for a while is abandoned: stop its upstream work and forget it. */
  sweep(now = Date.now()) {
    for (const [id, log] of this.jobs) {
      if (now - log.lastRead < this.idleMs) continue
      log.controller.abort()
      this.jobs.delete(id)
    }
  }

  get size(): number {
    return this.jobs.size
  }
}
