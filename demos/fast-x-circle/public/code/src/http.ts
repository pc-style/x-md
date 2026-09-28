import { CircleError, collectCircle, type CircleEvent } from './engine'

export function circleResponse(handle: string, fresh: boolean, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: CircleEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      try {
        await collectCircle(handle, { fresh, signal, onEvent: send })
      } catch (error) {
        const code = error instanceof CircleError ? error.code : 'unavailable'
        if (code !== 'aborted') send({ type: 'error', code })
      } finally {
        try { controller.close() } catch { /* closed with the client */ }
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

const hits = new Map<string, number[]>()
let active = 0

export function beginCircle(ip: string): { ok: true; finish: () => void } | { ok: false; retryAfter: number } {
  if (active >= 3) return { ok: false, retryAfter: 5 }
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((at) => now - at < 15 * 60 * 1000)
  if (recent.length >= 30) return { ok: false, retryAfter: 60 }
  recent.push(now)
  hits.set(ip, recent)
  active += 1
  return { ok: true, finish: () => { active = Math.max(0, active - 1) } }
}
