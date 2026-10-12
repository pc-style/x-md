import {
  ACCEPT,
  DEFAULT_BASE_URL,
  envApiKey,
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
  type ResolvedRetry,
  type RetryOptions,
} from './core.js'
import { MdfromxError, inputGuard, problemFrom } from './errors.js'
import type {
  Author,
  BrowseResponse,
  ConvertResponse,
  GetPostQuery,
  GetProfileQuery,
  ImportMeta,
  ImportProfilePostsQuery,
  ImportSuccessResponse,
  ListFollowersQuery,
  ListFollowingQuery,
  OperationId,
  Post,
  Problem,
  ReadPostRepliesQuery,
  SearchPostsQuery,
} from './generated/types.js'

export interface MdfromxOptions {
  /** Bearer key. Optional: the public API needs none. Falls back to `MDFROMX_API_KEY` on Node, Bun and Deno. */
  readonly apiKey?: string
  /** Defaults to the hosted API. Set this to a proxy or self-hosted instance when needed. */
  readonly baseUrl?: string
  /** Custom fetch, for tests, proxies or older runtimes. Default `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Retries for 429 and 503, honoring Retry-After. Default 2 retries, never waiting more than 30s. */
  readonly retry?: RetryOptions
  /** Extra headers sent with every request. */
  readonly headers?: Record<string, string>
}

export interface CallOptions {
  readonly signal?: AbortSignal
}

export interface PageOptions extends CallOptions {
  /** Stop after this many pages. Default: until `nextCursor` runs out. */
  readonly maxPages?: number
}

export type GetPostOptions = Omit<GetPostQuery, 'url' | 'handle' | 'id'> & CallOptions
export type RepliesOptions = ReadPostRepliesQuery & CallOptions
export type GetProfileOptions = GetProfileQuery & CallOptions
export type ProfilePagesOptions = Omit<GetProfileQuery, 'page' | 'includePosts'> & PageOptions
export type FollowersOptions = ListFollowersQuery & CallOptions
export type FollowersPagesOptions = Omit<ListFollowersQuery, 'page'> & PageOptions
export type FollowingOptions = ListFollowingQuery & CallOptions
export type FollowingPagesOptions = Omit<ListFollowingQuery, 'page'> & PageOptions
export type SearchOptions = Omit<SearchPostsQuery, 'q'> & CallOptions
export type SearchPagesOptions = Omit<SearchPostsQuery, 'q' | 'page'> & PageOptions
export type ImportOptions = ImportProfilePostsQuery & CallOptions
export type StreamPostsOptions = Omit<ImportProfilePostsQuery, 'index'> & CallOptions

/** One line of a streamed import: a post as it arrives, then a final meta line. */
export type ImportStreamEvent =
  | { readonly post: Post }
  | { readonly meta: ImportMeta, readonly profile?: Author }

export interface PostsApi {
  /** Read a post, its thread or conversation, as typed JSON (the `markdown` field holds the rendering). */
  get(post: PostRef, options?: GetPostOptions): Promise<ConvertResponse>
  /** Read a post as Markdown only. */
  markdown(post: PostRef, options?: GetPostOptions): Promise<string>
  /** A sample of direct replies to a post. Requires an API key. */
  replies(id: string, options?: RepliesOptions): Promise<BrowseResponse>
}

export interface ProfilesApi {
  /** A profile and one page of its latest posts. */
  get(handle: string, options?: GetProfileOptions): Promise<BrowseResponse>
  /** A profile and one page of its latest posts, as Markdown. */
  markdown(handle: string, options?: GetProfileOptions): Promise<string>
  /** Every page of a profile's latest posts: `for await (const page of x.profiles.pages('jack'))`. */
  pages(handle: string, options?: ProfilePagesOptions): AsyncIterable<BrowseResponse>
  followers(handle: string, options?: FollowersOptions): Promise<BrowseResponse>
  followersPages(handle: string, options?: FollowersPagesOptions): AsyncIterable<BrowseResponse>
  following(handle: string, options?: FollowingOptions): Promise<BrowseResponse>
  followingPages(handle: string, options?: FollowingPagesOptions): AsyncIterable<BrowseResponse>
  /** An account's post history in one response (`since`, `until`, `maxPosts`). */
  importPosts(handle: string, options?: ImportOptions): Promise<ImportSuccessResponse>
  /** An account's post history streamed as NDJSON, one post at a time. */
  streamPosts(handle: string, options?: StreamPostsOptions): AsyncIterable<ImportStreamEvent>
}

export interface SearchApi {
  /** One page of search results. */
  get(query: string, options?: SearchOptions): Promise<BrowseResponse>
  /** One page of search results as Markdown. */
  markdown(query: string, options?: SearchOptions): Promise<string>
  /** Every page of search results, following `nextCursor`. */
  pages(query: string, options?: SearchPagesOptions): AsyncIterable<BrowseResponse>
}

/**
 * Client for the mdfromx API.
 *
 * ```ts
 * const x = new Mdfromx()
 * const { posts } = await x.posts.get('https://x.com/jack/status/20')
 * ```
 */
export class Mdfromx {
  readonly posts: PostsApi
  readonly profiles: ProfilesApi
  readonly search: SearchApi

  readonly #apiKey: string | undefined
  readonly #baseUrl: string
  readonly #fetch: typeof globalThis.fetch
  readonly #retry: ResolvedRetry
  readonly #headers: Record<string, string>

  constructor(options: MdfromxOptions = {}) {
    this.#apiKey = options.apiKey === undefined ? envApiKey() : normalizeApiKey(options.apiKey)
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.#retry = resolveRetry(options.retry)
    this.#headers = { ...options.headers }

    const json = <T>(id: OperationId, path: Record<string, string>, opts: object | undefined) =>
      this.#send(id, path, opts, 'json').then(response => response.json() as Promise<T>)
    const text = (id: OperationId, path: Record<string, string>, opts: object | undefined) =>
      this.#send(id, path, opts, 'markdown').then(response => response.text())

    this.posts = {
      get: async (post, opts) => json<ConvertResponse>('getPost', {}, { ...opts, ...inputGuard(() => postRefParams(post)) }),
      markdown: async (post, opts) => text('getPost', {}, { ...opts, ...inputGuard(() => postRefParams(post)) }),
      replies: (id, opts) => json<BrowseResponse>('readPostReplies', { id }, opts),
    }

    this.profiles = {
      get: (handle, opts) => json<BrowseResponse>('getProfile', { handle }, opts),
      markdown: (handle, opts) => text('getProfile', { handle }, opts),
      pages: (handle, opts) => paginate(opts, cursor => json<BrowseResponse>('getProfile', { handle }, { ...opts, cursor })),
      followers: (handle, opts) => json<BrowseResponse>('listFollowers', { handle }, opts),
      followersPages: (handle, opts) => paginate(opts, cursor => json<BrowseResponse>('listFollowers', { handle }, { ...opts, cursor })),
      following: (handle, opts) => json<BrowseResponse>('listFollowing', { handle }, opts),
      followingPages: (handle, opts) => paginate(opts, cursor => json<BrowseResponse>('listFollowing', { handle }, { ...opts, cursor })),
      importPosts: (handle, opts) => json<ImportSuccessResponse>('importProfilePosts', { handle }, opts),
      streamPosts: (handle, opts) => this.#stream(handle, opts),
    }

    this.search = {
      get: (query, opts) => json<BrowseResponse>('searchPosts', {}, { ...opts, q: query }),
      markdown: (query, opts) => text('searchPosts', {}, { ...opts, q: query }),
      pages: (query, opts) => paginate(opts, cursor => json<BrowseResponse>('searchPosts', {}, { ...opts, q: query, cursor })),
    }
  }

  async #send(id: OperationId, path: Record<string, string>, opts: (CallOptions & object) | undefined, format: Format): Promise<Response> {
    const { signal, ...query } = opts ?? {}
    const url = inputGuard(() => operationUrl(this.#baseUrl, id, path, query, format))
    const headers = new Headers(this.#headers)
    headers.set('Accept', ACCEPT[format])
    if (this.#apiKey) headers.set('Authorization', `Bearer ${this.#apiKey}`)

    for (let attempt = 0; ; attempt++) {
      const response = await this.#fetch(url, { headers, signal })
      if (response.ok) return response
      const { code, message, problem } = problemFrom(response.status, await response.text())
      const retryAfter = retryAfterSeconds(response.headers.get('retry-after'), problem?.retry_after)
      const delay = retryDelayMs(response.status, retryAfter, attempt, this.#retry)
      if (delay === undefined) {
        throw new MdfromxError({ status: response.status, code, message, problem, retryAfter, headers: response.headers })
      }
      await sleep(delay, signal)
    }
  }

  async *#stream(handle: string, opts: StreamPostsOptions | undefined): AsyncGenerator<ImportStreamEvent> {
    const response = await this.#send('importProfilePosts', { handle }, opts, 'ndjson')
    if (!response.body) throw new TypeError('mdfromx: this runtime returned no response body to stream')
    let complete = false
    for await (const line of lines(response.body)) {
      const event = JSON.parse(line) as ImportStreamEvent | { error: Problem }
      if ('error' in event) {
        const problem = event.error
        throw new MdfromxError({ status: problem.status, code: problem.code, message: problem.detail || problem.title, problem })
      }
      if ('meta' in event) complete = true
      yield event
    }
    // The trailing meta line is the API's completion signal; without it the connection was cut.
    if (!complete) throw new MdfromxError({ status: response.status, code: STREAM_INCOMPLETE, message: STREAM_INCOMPLETE_MESSAGE })
  }
}

async function* paginate(
  opts: (PageOptions & { cursor?: string }) | undefined,
  fetchPage: (cursor: string | undefined) => Promise<BrowseResponse>,
): AsyncGenerator<BrowseResponse> {
  const maxPages = opts?.maxPages ?? Infinity
  const seen = new Set<string>()
  let cursor = opts?.cursor
  for (let count = 0; count < maxPages; count++) {
    const page = await fetchPage(cursor)
    yield page
    // Absent nextCursor is the only end signal; a short page is not. A repeated cursor would loop forever.
    const next = page.nextCursor
    if (!next || seen.has(next)) return
    seen.add(next)
    cursor = next
  }
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) yield line
      }
      if (done) break
    }
    // The API ends every line with a newline. A trailing fragment without one is a line the
    // connection cut, so it is dropped and the missing meta line reports the stream incomplete.
  } finally {
    // Stops the download when the caller breaks out of the loop early.
    await reader.cancel().catch(() => {})
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
