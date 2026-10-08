/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { Effect, Exit, Layer, Schema, Stream } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { describe, expect, it } from 'vitest'
import { Mdfromx, Schemas, UnknownApiError, type MdfromxConfig, type MdfromxService } from '../src/effect/index.js'

type Handler = (url: URL) => Response

function run<A, E>(handler: Handler, program: (x: MdfromxService) => Effect.Effect<A, E>, config: MdfromxConfig = {}) {
  const urls: URL[] = []
  const http = HttpClient.make((request, url) => {
    urls.push(url)
    return Effect.succeed(HttpClientResponse.fromWeb(request, handler(url)))
  })
  const layer = Mdfromx.layer({ apiKey: '', ...config }).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient)(http)))
  const exit = Effect.runPromiseExit(Mdfromx.use(program).pipe(Effect.provide(layer)))
  return { exit, urls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': status < 400 ? 'application/json' : 'application/problem+json' } })

const problem = (code: string, status: number, extra: Record<string, unknown> = {}) => json({
  type: `https://mdfromx.com/docs/reliability#${code}`, title: code, status, detail: `detail for ${code}`,
  instance: 'https://mdfromx.com/api/v1/x', code, resolution: 'retry', documentation_url: 'https://mdfromx.com/docs/reliability#errors', ...extra,
}, status)

const browse = (nextCursor?: string) => ({
  resource: 'search', page: 1, limit: 20, source: 'xsearch', markdown: '', cache: 'miss', posts: [{ id: '1', lang: null, reposted_by: null }],
  ...(nextCursor ? { nextCursor } : {}),
})

describe('Effect client', () => {
  it('decodes typed JSON and keeps unknown fields', async () => {
    const { exit, urls } = run(() => json({ ...browse(), brand_new_field: 1 }), x => x.search.get('bun', { limit: 3 }))
    const result = await exit
    expect(Exit.isSuccess(result)).toBe(true)
    if (Exit.isSuccess(result)) expect(result.value).toMatchObject({ resource: 'search', brand_new_field: 1 })
    expect(urls[0].searchParams.get('limit')).toBe('3')
    expect(urls[0].searchParams.get('format')).toBe('json')
  })

  it('fails with one tag per problem code', async () => {
    const program = (x: MdfromxService) => x.profiles.get('jack').pipe(
      Effect.catchTag('RateLimited', e => Effect.succeed(`rate limited, retry in ${e.retryAfter}s`)),
    )
    const { exit } = run(() => problem('rate_limited', 429, { retry_after: 900 }), program)
    expect(await exit).toEqual(Exit.succeed('rate limited, retry in 900s'))
  })

  it('maps unlisted codes to UnknownApiError', async () => {
    const { exit } = run(() => problem('firecrawl_network', 502), x => Effect.flip(x.posts.get('20')))
    const result = await exit
    expect(Exit.isSuccess(result) && result.value).toBeInstanceOf(UnknownApiError)
    expect(Exit.isSuccess(result) && result.value).toMatchObject({ _tag: 'UnknownApiError', code: 'firecrawl_network', status: 502 })
  })

  it('fails with a SchemaError when a response does not match the contract', async () => {
    const { exit } = run(() => json({ resource: 'nope' }), x => Effect.flip(x.search.get('a')))
    const result = await exit
    expect(Exit.isSuccess(result) && Schema.isSchemaError(result.value)).toBe(true)
  })

  it('retries 503 after Retry-After', async () => {
    let n = 0
    const { exit, urls } = run(() => (n++ === 0 ? problem('import_busy', 503, { retry_after: 0 }) : json(browse())), x => x.search.get('a'))
    expect(Exit.isSuccess(await exit)).toBe(true)
    expect(urls).toHaveLength(2)
  })

  it('streams pages until nextCursor is absent', async () => {
    const cursors = ['c1', undefined]
    const { exit, urls } = run(() => json(browse(cursors.shift())), x => Stream.runCollect(x.search.pages('a')))
    const result = await exit
    expect(Exit.isSuccess(result) && result.value.length).toBe(2)
    expect(urls.map(u => u.searchParams.get('cursor'))).toEqual([null, 'c1'])
  })

  it('streams NDJSON imports and fails on an error line', async () => {
    const ok = '{"post":{"id":"1"}}\n{"meta":{"handle":"jack","count":1,"until":"2026-01-01","truncated":false,"floor_reached":true,"with_replies":true,"with_reposts":true,"only_replies":false,"concurrency":16,"windows":1,"pages":1,"duration_ms":5,"source":"fxtwitter"}}\n'
    const done = await run(() => new Response(ok), x => Stream.runCollect(x.profiles.streamPosts('jack'))).exit
    expect(Exit.isSuccess(done) && done.value.map(e => ('post' in e ? 'post' : 'meta'))).toEqual(['post', 'meta'])

    const bad = '{"post":{"id":"1"}}\n{"error":{"type":"https://mdfromx.com/docs/reliability#upstream-error","title":"Upstream failed","status":502,"detail":"walk failed","instance":"https://mdfromx.com/api/v1/x","code":"upstream_error","resolution":"retry","documentation_url":"https://mdfromx.com/docs"}}\n'
    const failed = await run(() => new Response(bad), x => Effect.flip(Stream.runCollect(x.profiles.streamPosts('jack')))).exit
    expect(Exit.isSuccess(failed) && failed.value).toMatchObject({ _tag: 'UpstreamError', status: 502 })
  })
})

describe('generated schemas', () => {
  // The spec's own examples are real responses; the schemas generated from that spec must accept them.
  const doc = JSON.parse(readFileSync(new URL('../../../public/openapi.json', import.meta.url), 'utf8'))
  const examples: Record<string, { value: unknown }> = doc.components.examples
  const cases: [string, Schema.Codec<unknown>][] = [
    ['postResponse', Schemas.ConvertResponse as Schema.Codec<unknown>],
    ['profileResponse', Schemas.BrowseResponse as Schema.Codec<unknown>],
    ['searchResponse', Schemas.BrowseResponse as Schema.Codec<unknown>],
    ['oembedResponse', Schemas.OEmbedResponse as Schema.Codec<unknown>],
    ['rate_limited', Schemas.Problem as Schema.Codec<unknown>],
  ]

  for (const [name, schema] of cases) {
    it(`decodes the ${name} example`, () => {
      expect(() => Schema.decodeUnknownSync(schema)(examples[name].value)).not.toThrow()
    })
  }
})
