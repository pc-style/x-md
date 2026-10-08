# mdfromx

Typed TypeScript client for [mdfromx](https://mdfromx.com): public X posts, threads, profiles, followers and search as JSON or Markdown. Plain `fetch` with no dependencies, plus an [Effect](https://effect.website) flavor.

```bash
npm install mdfromx
```

```ts
import { Mdfromx } from 'mdfromx'

const x = new Mdfromx()

const { posts, markdown } = await x.posts.get('https://x.com/jack/status/20')
const profile = await x.profiles.get('jack', { limit: 5 })

for await (const page of x.search.pages('bun', { maxPages: 3 })) {
  console.log(page.posts?.length)
}
```

- The `/api/v1` post, profile and search routes: `posts.get`, `posts.replies`, `profiles.get`, `profiles.followers`, `profiles.following`, `profiles.importPosts`, `profiles.streamPosts` (NDJSON), `search.get`, plus `markdown()` and `pages()` variants.
- Types generated from the API's OpenAPI document.
- Throws `MdfromxError` with a typed `code` for every documented problem.
- Retries `429` and `503`, waiting the `Retry-After` the API sends.
- An API key is optional: `new Mdfromx({ apiKey })`, or set `MDFROMX_API_KEY`.

## Effect

```bash
npm install mdfromx effect
```

```ts
import { Effect } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { Mdfromx } from 'mdfromx/effect'

const program = Mdfromx.use(x => x.posts.get('https://x.com/jack/status/20')).pipe(
  Effect.catchTag('RateLimited', error => Effect.fail(`retry in ${error.retryAfter}s`)),
)

program.pipe(Effect.provide(Mdfromx.layer()), Effect.provide(FetchHttpClient.layer), Effect.runPromise)
```

`Effect` and `Stream` results, one tagged error per problem code, and every response decoded with Effect Schema.

Full guide: [mdfromx.com/docs/sdk](https://mdfromx.com/docs/sdk). MIT licensed.
