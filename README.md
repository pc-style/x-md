# x.md

Turn public X posts, conversations, profiles, search results, and social graphs into compact Markdown for agents. The hosted API is available at [x.pcstyle.dev](https://x.pcstyle.dev); no X API key is required for the default provider path.

> [!IMPORTANT]
> **Status: beta.** Routes and output fields can change as upstream X providers change. The compatibility target for self-hosting is Bun 1.4 (see `.bun-version`) and the locked dependencies in this repository.

**Not affiliated with X Corp. Public lists are not available.**

## What it returns

- Compact, agent-friendly Markdown by default; add `?full=true` for dates, metrics, and richer profile details.
- A source URL for every post and reply, including quoted posts.
- Direct video URLs, thumbnails, duration/dimensions/bitrate when supplied, and all available video variants.
- Conversation context by default: parents, the author's thread, and top replies. Use `context` and `replies` to narrow it.
- Structured JSON with the rendered Markdown and raw post/profile data via `?format=json` or `Accept: application/json`.
- Profiles with profile data and up to 20 latest original posts by default.
- Search, followers, and following, with cursor or bounded page pagination.

## Use the hosted API

Replace `x.com` with `x.pcstyle.dev` on a public status URL:

```text
https://x.com/handle/status/1234567890
https://x.pcstyle.dev/handle/status/1234567890
```

```bash
curl -sS -H 'Accept: text/markdown' \
  'https://x.pcstyle.dev/handle/status/1234567890'

curl -sS -G 'https://x.pcstyle.dev/api/v1/posts' \
  --data-urlencode 'url=https://x.com/handle/status/1234567890'
```

Browsers that request HTML get a readable page containing the Markdown. Agents can explicitly request `text/markdown`. Discord, Telegram, Slack, and other preview bots receive Open Graph embed HTML for the same status URL, including multiple images on Discord, video streams where supported, video thumbnails on Slack, quote/poll text, and an oEmbed engagement line.

## For agents

Everything here is public, needs no key, and is meant to be read by a program:

| Surface | Where | What it is |
| --- | --- | --- |
| Markdown negotiation | any read route, or `/`, `/docs`, `/about` | `Accept: text/markdown` returns Markdown; docs pages also answer to a `.md` suffix or `?mode=agent`. Responses carry `Vary: Accept` and a `Link: …; rel="alternate"` to the Markdown twin |
| `/llms.txt` | [x.pcstyle.dev/llms.txt](https://x.pcstyle.dev/llms.txt) | What x.md is for, when *not* to use it, and every route, in one text file |
| `/openapi.json` | [x.pcstyle.dev/openapi.json](https://x.pcstyle.dev/openapi.json) | OpenAPI 3.1: parameters, response schemas, error bodies, quotas, lifecycle |
| `/api` | [x.pcstyle.dev/api](https://x.pcstyle.dev/api) | A small JSON index for an agent that has only the domain |
| `/mcp` | [x.pcstyle.dev/mcp](https://x.pcstyle.dev/mcp) | MCP server over Streamable HTTP, exposing the same reads as tools |
| Agent skill | `bunx skills add pc-style/x-md -g -y --skill browse-x` | The `browse-x` skill for coding agents |
| `/.well-known/ard.json` | [x.pcstyle.dev/.well-known/ard.json](https://x.pcstyle.dev/.well-known/ard.json) | Agentic Resource Discovery catalog of every machine surface above |

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem documents (`application/problem+json`) with a stable machine `code`, a human `detail`, and a `resolution` hint — see the [error catalogue](https://x.pcstyle.dev/docs/errors). Rate limits are advertised on every response with the IETF `RateLimit-Policy` and `RateLimit` structured fields plus the `RateLimit-Limit`/`-Remaining`/`-Reset` compatibility triple, and `Retry-After` on a `429`.

### Versioning

`/api/v1/*` is the stable machine surface: `/api/v1/posts`, `/api/v1/profiles/{handle}` (`/followers`, `/following`), `/api/v1/search`, `/api/v1/oembed`. Additive changes ship inside `v1`; breaking ones ship as a new path prefix, and `v1` keeps working for at least 12 months after a successor appears. The permalink routes (`/{handle}`, `/{handle}/status/{id}`, `/search`, `/oembed`) are the unversioned product surface and are not deprecated.

`GET /api/convert` and `GET /api/browse` are aliases scheduled for deprecation on **2026-09-15**, with a **2027-09-15** sunset. They still work unchanged and already announce the schedule on every response:

```http
Deprecation: @1789430400
Sunset: Wed, 15 Sep 2027 00:00:00 GMT
Link: <https://x.pcstyle.dev/api/v1/posts>; rel="successor-version"
```

Full policy: [x.pcstyle.dev/docs/versioning](https://x.pcstyle.dev/docs/versioning).

## Post conversion

Both `GET /:handle/status/:id` and `GET /api/v1/posts?url=…` support:

| Parameter | Default | Supported values |
| --- | --- | --- |
| `format` | `markdown` | `markdown`, `obsidian`, `json` |
| `full` | false | `true`, `1`, or `yes` enables expanded Markdown; Obsidian is always expanded |
| `thread` | `full` | `off`, `full`, `conversation`, or a limit from `2` to `100` |
| `context` | `full` | `full` includes parents, author thread, and selected replies; `thread` excludes unrelated replies |
| `replies` | `top` | `top`, `recent`, `off` |
| `userinfo` | `off` | `off`, `author`, `all` |
| `nocache` | false | `true`, `1`, or `yes` bypasses the application cache |

`thread=off` returns only the requested post. The default conversation result is ordered and labels posts as parent, post, thread, or reply when that data is available. Provider fallbacks can return less context, article content, or quote data.

```bash
# Expanded conversation without replies
curl -sS 'https://x.pcstyle.dev/handle/status/1234567890?full=true&replies=off'

# Author thread only, capped at 20 posts
curl -sS 'https://x.pcstyle.dev/handle/status/1234567890?context=thread&thread=20'

# Structured output
curl -sS -H 'Accept: application/json' \
  'https://x.pcstyle.dev/handle/status/1234567890'
curl -sS 'https://x.pcstyle.dev/handle/status/1234567890?format=json'
```

JSON conversion responses contain `url`, `markdown`, raw `posts`, `compact`, `warnings`, `postCount`, `source`, `cache`, and `format`. Media in both Markdown and `posts` includes direct video data when the upstream provider exposes it; availability and lifetime of X CDN URLs are controlled by X.

Preview bots hitting `GET /:handle/status/:id` receive embed HTML instead of Markdown. `GET /oembed` is the Discord oEmbed document advertised from that HTML. Explicit `?format=` or `Accept: application/json` / `text/markdown` still wins over user-agent detection.

## Browse profiles and X

Browse routes return compact Markdown by default and structured data with `?format=json` or `Accept: application/json`.

| Route | Behavior |
| --- | --- |
| `GET /:handle` | Profile data and latest original posts (replies and reposts filtered out) |
| `GET /search?q=…` | Search posts or users; `feed=latest`, `top`, `photos`, `videos`, or `users` (`media` aliases `photos`) (invalid values fall back to `latest`) |
| `GET /:handle/followers` | Followers |
| `GET /:handle/following` | Accounts followed |

The default `limit` is 20 and the maximum is 20. Pass the opaque `cursor` returned as `nextCursor`, or use `page=1` through `page=10`; values above 10 are clamped. Without a cursor, page pagination walks upstream pages and can be slower. A cursor fetches one upstream page. Results can contain fewer items than `limit`, especially profiles, because replies and reposts are filtered after retrieval.

```bash
curl -sS 'https://x.pcstyle.dev/elonmusk'
curl -sS 'https://x.pcstyle.dev/search?q=typescript&feed=latest&limit=20'
curl -sS 'https://x.pcstyle.dev/elonmusk/followers?full=true'
curl -sS -H 'Accept: application/json' \
  'https://x.pcstyle.dev/elonmusk/following?limit=20'
```

### Versioned browse routes

```bash
curl -sS 'https://x.pcstyle.dev/api/v1/profiles/elonmusk'

curl -sS -G 'https://x.pcstyle.dev/api/v1/search' \
  --data-urlencode 'q=typescript' \
  --data-urlencode 'feed=top' \
  --data-urlencode 'format=json'
```

The older `GET /api/browse?resource=profile|search|followers|following` alias takes the same options and still works, but it is deprecated and sunsets on 2027-09-15.

Search feeds are case-insensitive. `users` returns account profiles in `users`; other feeds return `posts`. Latest and Top try FxTwitter first, then a custom-built live search provider, and can fall back to web-indexed snippets. Photos, Videos, and Users use the live provider directly.

### Search limits

- Live search allows **5 uncached requests per minute per IP**. Cache hits are free.
- Requests served by the live provider have an additional allowance of **10 per IP per 15-minute window**, drawn from a shared public pool. All feeds share it, and each page of a page walk counts as one request.
- A rejected request returns `429` with `Retry-After` in seconds until the window resets. An upstream outage returns `503` with `Retry-After: 30`.

Every response advertises what is left, so a client can pace itself instead of discovering the limit by hitting it:

```http
RateLimit-Policy: "api-ip";q=600;w=60, "search-ip";q=5;w=60, "account-ip";q=10;w=900
RateLimit: "api-ip";r=599;t=60, "search-ip";r=5;t=60, "account-ip";r=10;t=900
RateLimit-Limit: 5
RateLimit-Remaining: 5
RateLimit-Reset: 60
```

`q` is the quota, `w` the window in seconds, `r` what is left, `t` the seconds until that window resets. The unprefixed `RateLimit-Limit`/`-Remaining`/`-Reset` triple describes the tightest policy. Ignore these values on a response with a positive `Age`: a CDN hit replays the state of whoever filled the cache.

Counters are per instance unless a shared KV store is configured.

Browse JSON includes the resource-specific `profile`, `posts`, or `users`, plus `page`, `limit`, optional `nextCursor`, rendered `markdown`, and cache status. The verified upstream profile API does not expose pinned-post markers, and public X lists are explicitly unsupported.

## Agent skill

Install the hosted skill, `browse-x`, with the [skills CLI](https://skills.sh/):

```bash
bunx skills add pc-style/x-md -g -y --skill browse-x
```

The skill uses `https://x.pcstyle.dev`; it does not require a local checkout or local API keys. Its helper is a TypeScript CLI (`bun skills/browse-x/scripts/browse-x.ts …`) that needs Bun, and exits with code 3 on a rate limit after printing `Retry-After`, so agents know exactly how long to wait.

The skills CLI command follows the repository's current default branch. For a reviewable, immutable copy, check out the newest tag on the [releases page](https://github.com/pc-style/x-md/releases) and copy `skills/browse-x` from that checkout.

## Caching and reliability

FxTwitter is the primary data provider and X's syndication endpoint is the fallback. Self-hosted deployments may additionally configure Context.dev and Firecrawl. `X-Source` reports `fxtwitter`, `syndication`, `contextdev`, or `firecrawl`; `X-Cache` reports cache status. Browse endpoints use FxTwitter directly.

Successful responses are cached for about one hour by default (`CACHE_TTL_SECONDS=3600`) and send cache headers unless bypassed. `nocache=true` bypasses the application cache, but it cannot bypass upstream caches. Public X data can be missing, delayed, rate-limited, deleted, protected, or shaped differently by upstream providers, so context, counts, media variants, and pagination cursors are best effort. The API does not authenticate to private accounts and does not provide public lists.

## Trust and privacy boundaries

- The hosted service receives the public X URL, handle, or search query you request and sends it to FxTwitter or X's public syndication service. Successful results are cached for about one hour and can be served to other callers requesting the same public resource.
- Optional Context.dev and Firecrawl fallbacks are disabled unless a self-hosted operator configures their API keys. When enabled, the public X URL is sent to that provider.
- The hosted `browse-x` skill sends its arguments to `x.pcstyle.dev`. Do not put secrets or private-account information in URLs or search terms.
- Optional, disabled-by-default PostHog dataset capture archives allowlisted structured public results, not just metrics. See the [archive/privacy policy](docs/archive.mdx) for actor pseudonyms, opt-out controls, retention duties, and delivery limits.
- Media links point to upstream X/FxTwitter CDNs. Fetching those links is outside x.md's cache and privacy boundary.

x.md is read-only and does not accept X credentials, post content, or account mutations. It is the canonical implementation, has no successor, and is not affiliated with X Corp.

## Self-host

```bash
git clone --depth 1 https://github.com/pc-style/x-md.git
cd x-md
bun install --frozen-lockfile
cp .env.local.example .env.local
bun run dev
```

That clones `main`, which is the moving target. For a reviewable source snapshot, clone with `--branch` and the newest tag from the [releases page](https://github.com/pc-style/x-md/releases) — the hosted API runs the newest tag — and keep the lockfile. No container image or deployment artifact is published; you deploy the source.

Optional environment variables:

| Variable | Description |
| --- | --- |
| `CONTEXT_DEV_API_KEY` | Context.dev converter fallback |
| `X_SEARCH_SESSIONS_JSON` | Configuration for the live search provider; the expected shape is defined in `lib/xsearch.ts`. Locally, the gitignored `accounts.local.json` is read instead. Without it, Photos, Videos, and Users return `503` |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Optional Upstash/Vercel KV REST endpoint (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) for shared rate-limit counters and durable app state. Falls back to per-instance memory |
| `FIRECRAWL_API_KEY` | Firecrawl converter fallback and degraded `/search` fallback (web-indexed x.com snippets, `X-Source: firecrawl`, `X-Search-Degraded: true`) when live X search is down |
| `CACHE_TTL_SECONDS` | Cache TTL; default `3600` |
| `CACHE_DISABLED` | Set to `1` to disable caching |
| `CACHE_PERSIST` | Set to `0` for memory-only caching |

Deploy with Vercel after `bun run build`; `vercel.json` configures `dist`, the API handlers, and all public route rewrites.

## Project layout

```text
api/convert.ts     Post conversion handler
api/browse.ts      Profile, search, followers, and following handler
api/oembed.ts      Discord oEmbed JSON for chat previews
lib/               Providers, rendering, pagination, cache, and embeds
src/               Vite landing page and rendered documentation
```

## License

[MIT](LICENSE)

## Documentation

Docs are MDX pages in `docs/`, built with Blume and mounted at `/docs`. Run `bun run docs:dev` for the documentation server. `bun run build` builds docs first, then the landing page into the same `dist` directory. Configure navigation and site metadata in `blume.config.ts`; `theme.css` maps the shared `src/tokens.css` palette into Blume.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and PR expectations, and [SECURITY.md](SECURITY.md) for private vulnerability reports.
