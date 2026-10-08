import { Config, Context, Duration, Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import { HttpClient, HttpClientRequest, type HttpClientError, type HttpClientResponse } from 'effect/http'
import type {
  FollowersOptions,
  FollowersPagesOptions,
  FollowingOptions,
  FollowingPagesOptions,
  GetPostOptions,
  GetProfileOptions,
  ImportOptions,
  ImportStreamEvent,
  ProfilePagesOptions,
  RepliesOptions,
  SearchOptions,
  SearchPagesOptions,
  StreamPostsOptions,
} from '../client.js'
import {
  ACCEPT,
  API_KEY_ENV,
  DEFAULT_BASE_URL,
  normalizeApiKey,
  operationUrl,
  postRefParams,
  resolveRetry,
  retryAfterSeconds,
  retryDelayMs,
  STREAM_INCOMPLETE,
  STREAM_INCOMPLETE_MESSAGE,
  type Format,
  type PostRef,
  type RetryOptions,
} from '../core.js'
import { problemFrom } from '../errors.js'
import type * as T from '../generated/types.js'
import { apiError } from './errors.js'
import type { ApiError } from './generated/errors.js'
import * as S from './generated/schemas.js'

// AbortSignal is the plain client's cancellation; Effect interrupts instead.
type Opts<O> = Omit<O, 'signal'>

export interface MdfromxConfig {
  /** Bearer key. Optional: the public API needs none. Falls back to the `MDFROMX_API_KEY` config value. */
  readonly apiKey?: string | Redacted.Redacted<string>
  /** Default `https://mdfromx.com`. `https://x.pcstyle.dev` serves the same API. */
  readonly baseUrl?: string
  /** Retries for 429 and 503, honoring Retry-After. Default 2 retries, never waiting more than 30s. */
  readonly retry?: RetryOptions
}

/** Every way a call can fail: an API problem (one tag per code), transport, or a response that did not decode. */
export type MdfromxFailure = ApiError | HttpClientError.HttpClientError | Schema.SchemaError

type Call<A> = Effect.Effect<A, MdfromxFailure>
type Pages<A> = Stream.Stream<A, MdfromxFailure>

export interface MdfromxService {
  readonly posts: {
    get(post: PostRef, options?: Opts<GetPostOptions>): Call<T.ConvertResponse>
    markdown(post: PostRef, options?: Opts<GetPostOptions>): Call<string>
    replies(id: string, options?: Opts<RepliesOptions>): Call<T.BrowseResponse>
  }
  readonly profiles: {
    get(handle: string, options?: Opts<GetProfileOptions>): Call<T.BrowseResponse>
    markdown(handle: string, options?: Opts<GetProfileOptions>): Call<string>
    pages(handle: string, options?: Opts<ProfilePagesOptions>): Pages<T.BrowseResponse>
    followers(handle: string, options?: Opts<FollowersOptions>): Call<T.BrowseResponse>
    followersPages(handle: string, options?: Opts<FollowersPagesOptions>): Pages<T.BrowseResponse>
    following(handle: string, options?: Opts<FollowingOptions>): Call<T.BrowseResponse>
    followingPages(handle: string, options?: Opts<FollowingPagesOptions>): Pages<T.BrowseResponse>
    importPosts(handle: string, options?: Opts<ImportOptions>): Call<T.ImportSuccessResponse>
    streamPosts(handle: string, options?: Opts<StreamPostsOptions>): Pages<ImportStreamEvent>
  }
  readonly search: {
    get(query: string, options?: Opts<SearchOptions>): Call<T.BrowseResponse>
    markdown(query: string, options?: Opts<SearchOptions>): Call<string>
    pages(query: string, options?: Opts<SearchPagesOptions>): Pages<T.BrowseResponse>
  }
}

// One NDJSON line of a streamed import.
const ImportLine = Schema.fromJsonString(Schema.Union([
  Schema.Struct({ post: S.Post }),
  Schema.Struct({ meta: S.ImportMeta, profile: Schema.optionalKey(S.Author) }),
  Schema.Struct({ error: S.Problem }),
]))

const make = (config: MdfromxConfig = {}) => Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const raw = config.apiKey === undefined
    ? Option.getOrUndefined(yield* Config.option(Config.Redacted(API_KEY_ENV)).pipe(Effect.orElseSucceed(() => Option.none())))
    : config.apiKey
  const key = normalizeApiKey(raw === undefined || typeof raw === 'string' ? raw : Redacted.value(raw))
  const apiKey = key === undefined ? undefined : Redacted.make(key)
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
  const retry = resolveRetry(config.retry)

  // Suspended, so invalid input (an empty handle) fails the Effect instead of throwing at the call site.
  const send = (id: T.OperationId, path: Record<string, string>, opts: object | undefined, format: Format) => Effect.suspend(() => {
    const url = operationUrl(baseUrl, id, path, opts, format)
    let request = HttpClientRequest.get(url).pipe(HttpClientRequest.accept(ACCEPT[format]))
    if (apiKey) request = request.pipe(HttpClientRequest.bearerToken(apiKey))

    const attempt = (n: number): Effect.Effect<HttpClientResponse.HttpClientResponse, MdfromxFailure> =>
      client.execute(request).pipe(Effect.flatMap(response => {
        if (response.status >= 200 && response.status < 300) return Effect.succeed(response)
        return response.text.pipe(Effect.flatMap(body => {
          const { code, message, problem } = problemFrom(response.status, body)
          const retryAfter = retryAfterSeconds(response.headers['retry-after'], problem?.retry_after)
          const delay = retryDelayMs(response.status, retryAfter, n, retry)
          return delay === undefined
            ? Effect.fail(apiError({ status: response.status, code, message, problem, retryAfter }))
            : Effect.sleep(Duration.millis(delay)).pipe(Effect.andThen(attempt(n + 1)))
        }))
      }))
    return attempt(0)
  })

  const json = <A>(schema: Schema.Codec<A>, id: T.OperationId, path: Record<string, string>, opts: object | undefined): Call<A> =>
    send(id, path, opts, 'json').pipe(
      Effect.flatMap(response => response.json),
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    )

  const text = (id: T.OperationId, path: Record<string, string>, opts: object | undefined): Call<string> =>
    send(id, path, opts, 'markdown').pipe(Effect.flatMap(response => response.text))

  // Follow nextCursor until it is absent (a short page is not the end) or repeats.
  const paginate = (
    opts: { readonly cursor?: string, readonly maxPages?: number } | undefined,
    fetchPage: (cursor: string | undefined) => Call<T.BrowseResponse>,
  ): Pages<T.BrowseResponse> => {
    const pages = Stream.paginate(
      { cursor: opts?.cursor, seen: new Set<string>() },
      state => fetchPage(state.cursor).pipe(Effect.map(page => {
        const next = page.nextCursor
        const more = next !== undefined && next !== '' && !state.seen.has(next)
        return [[page], more ? Option.some({ cursor: next, seen: new Set([...state.seen, next]) }) : Option.none()] as const
      })),
    )
    return opts?.maxPages === undefined ? pages : pages.pipe(Stream.take(opts.maxPages))
  }

  const streamPosts = (handle: string, opts: object | undefined): Pages<ImportStreamEvent> => Stream.suspend(() => {
    let complete = false
    return send('importProfilePosts', { handle }, opts, 'ndjson').pipe(
      Effect.map(response => response.stream),
      Stream.unwrap,
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter(line => line.trim() !== ''),
      Stream.mapEffect(line => Schema.decodeUnknownEffect(ImportLine)(line).pipe(Effect.flatMap(event =>
        'error' in event
          ? Effect.fail(apiError({ status: event.error.status, code: event.error.code, message: event.error.detail || event.error.title, problem: event.error }))
          : Effect.sync(() => {
            if ('meta' in event) complete = true
            return event as ImportStreamEvent
          })))),
      // The trailing meta line is the API's completion signal; without it the connection was cut.
      Stream.concat(Stream.suspend(() => complete
        ? Stream.empty
        : Stream.fail(apiError({ status: 200, code: STREAM_INCOMPLETE, message: STREAM_INCOMPLETE_MESSAGE })))),
    )
  })

  const service: MdfromxService = {
    posts: {
      get: (post, opts) => Effect.suspend(() => json(S.ConvertResponse, 'getPost', {}, { ...opts, ...postRefParams(post) })),
      markdown: (post, opts) => Effect.suspend(() => text('getPost', {}, { ...opts, ...postRefParams(post) })),
      replies: (id, opts) => json(S.BrowseResponse, 'readPostReplies', { id }, opts),
    },
    profiles: {
      get: (handle, opts) => json(S.BrowseResponse, 'getProfile', { handle }, opts),
      markdown: (handle, opts) => text('getProfile', { handle }, opts),
      pages: (handle, opts) => paginate(opts, cursor => json(S.BrowseResponse, 'getProfile', { handle }, { ...opts, cursor })),
      followers: (handle, opts) => json(S.BrowseResponse, 'listFollowers', { handle }, opts),
      followersPages: (handle, opts) => paginate(opts, cursor => json(S.BrowseResponse, 'listFollowers', { handle }, { ...opts, cursor })),
      following: (handle, opts) => json(S.BrowseResponse, 'listFollowing', { handle }, opts),
      followingPages: (handle, opts) => paginate(opts, cursor => json(S.BrowseResponse, 'listFollowing', { handle }, { ...opts, cursor })),
      importPosts: (handle, opts) => json(S.ImportSuccessResponse, 'importProfilePosts', { handle }, opts),
      streamPosts,
    },
    search: {
      get: (query, opts) => json(S.BrowseResponse, 'searchPosts', {}, { ...opts, q: query }),
      markdown: (query, opts) => text('searchPosts', {}, { ...opts, q: query }),
      pages: (query, opts) => paginate(opts, cursor => json(S.BrowseResponse, 'searchPosts', {}, { ...opts, q: query, cursor })),
    },
  }
  return service
})

/**
 * The mdfromx API as an Effect service. Provide `Mdfromx.layer()` and an
 * `HttpClient` (for example `FetchHttpClient.layer` from `effect/http`).
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const x = yield* Mdfromx
 *   return yield* x.posts.get('https://x.com/jack/status/20')
 * })
 * program.pipe(Effect.provide(Mdfromx.layer()), Effect.provide(FetchHttpClient.layer))
 * ```
 */
export class Mdfromx extends Context.Service<Mdfromx, MdfromxService>()('mdfromx/Mdfromx') {
  static layer(config?: MdfromxConfig): Layer.Layer<Mdfromx, never, HttpClient.HttpClient> {
    return Layer.effect(Mdfromx)(make(config))
  }
}
