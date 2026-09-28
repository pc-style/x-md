import { beginCircle, circleResponse } from './src/http'

const root = new URL('./public/', import.meta.url)
const port = Number(process.env.PORT ?? 8787)

function clientIp(request: Request): string {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local'
}

function wrap(response: Response, finish: () => void): Response {
  const reader = response.body?.getReader()
  if (!reader) {
    finish()
    return response
  }
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          finish()
          controller.close()
          return
        }
        controller.enqueue(chunk.value)
      } catch (error) {
        finish()
        controller.error(error)
      }
    },
    cancel() {
      finish()
      void reader.cancel()
    },
  })
  return new Response(stream, { status: response.status, headers: response.headers })
}

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true, configured: Boolean(process.env.X_MD_API_KEY) })
    }
    if (url.pathname === '/api/circle') {
      const gate = beginCircle(clientIp(request))
      if (!gate.ok) return Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } })
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(55_000)])
      const response = circleResponse(url.searchParams.get('handle') ?? '', url.searchParams.get('fresh') === '1', signal)
      return wrap(response, gate.finish)
    }
    const path = url.pathname === '/' ? '/index.html' : url.pathname
    if (path.includes('..')) return new Response('Not found', { status: 404 })
    const file = Bun.file(new URL(path.slice(1), root))
    if (!(await file.exists())) return new Response('Not found', { status: 404 })
    return new Response(file)
  },
})

console.log(`Fast X Circle listening on http://127.0.0.1:${port}`)
