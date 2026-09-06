# x.md

Turn public X posts, conversations, profiles, search results, and social graphs into compact Markdown for agents. The hosted API is available at [x.pcstyle.dev](https://x.pcstyle.dev); no X API key is required for the default provider path.

> [!IMPORTANT]
> **Status: beta.** Routes and output fields can change as upstream X providers change. The compatibility target for self-hosting is Bun 1.3.10 and the locked dependencies in this repository.

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

curl -sS -G 'https://x.pcstyle.dev/api/convert' \
  --data-urlencode 'url=https://x.com/handle/status/1234567890'
```

Browsers that request HTML get a readable page containing the Markdown. Agents can explicitly request `text/markdown`. Discord, Telegram, Slack, and other preview bots receive Open Graph embed HTML for the same status URL, including multiple images on Discord, video streams where supported, video thumbnails on Slack, quote/poll text, and an oEmbed engagement line.

## Post conversion

Both `GET /:handle/status/:id` and `GET /api/convert?url=…` support:

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

### Direct `/api/browse` usage

Use `resource=profile|search|followers|following`, plus the corresponding `handle` or `q`:

```bash
curl -sS -G 'https://x.pcstyle.dev/api/browse' \
  --data-urlencode 'resource=profile' \
  --data-urlencode 'handle=elonmusk'

curl -sS -G 'https://x.pcstyle.dev/api/browse' \
  --data-urlencode 'resource=search' \
  --data-urlencode 'q=typescript' \
  --data-urlencode 'feed=top' \
  --data-urlencode 'format=json'
```

Search feeds are case-insensitive. `users` returns account profiles in `users`; other feeds return `posts`. Photos, Videos, and Users require configured X sessions; Latest and Top try FxTwitter first and can fall back to web-indexed snippets. Live search is limited to 75 uncached requests per minute per IP. Each configured account allows 100 upstream calls per 15 minutes, including page walks and failed attempts; cache hits are free. Counters are per instance unless a shared KV store is configured.

Browse JSON includes the resource-specific `profile`, `posts`, or `users`, plus `page`, `limit`, optional `nextCursor`, rendered `markdown`, and cache status. The verified upstream profile API does not expose pinned-post markers, and public X lists are explicitly unsupported.

## Agent skill

Install the hosted skill, `browse-x`, with the [skills CLI](https://skills.sh/):

```bash
bunx skills add pc-style/x-md -g -y --skill browse-x
```

The skill uses `https://x.pcstyle.dev`; it does not require a local checkout or local API keys.

The skills CLI command follows the repository's current default branch. This project has no tag or release to pin yet, so treat that command as a convenience install: review the copied `SKILL.md` and script before use. For an immutable audit, inspect commit `146d116a19c93da81a0ae741c19bc3bd74435229` and copy `skills/browse-x` from that checkout.

## Caching and reliability

FxTwitter is the primary data provider and X's syndication endpoint is the fallback. Self-hosted deployments may additionally configure Context.dev and Firecrawl. `X-Source` reports `fxtwitter`, `syndication`, `contextdev`, or `firecrawl`; `X-Cache` reports cache status. Browse endpoints use FxTwitter directly.

Successful responses are cached for about one hour by default (`CACHE_TTL_SECONDS=3600`) and send cache headers unless bypassed. `nocache=true` bypasses the application cache, but it cannot bypass upstream caches. Public X data can be missing, delayed, rate-limited, deleted, protected, or shaped differently by upstream providers, so context, counts, media variants, and pagination cursors are best effort. The API does not authenticate to private accounts and does not provide public lists.

## Trust and privacy boundaries

- The hosted service receives the public X URL, handle, or search query you request and sends it to FxTwitter or X's public syndication service. Successful results are cached for about one hour and can be served to other callers requesting the same public resource.
- Optional Context.dev and Firecrawl fallbacks are disabled unless a self-hosted operator configures their API keys. When enabled, the public X URL is sent to that provider.
- The hosted `browse-x` skill sends its arguments to `x.pcstyle.dev`. Do not put secrets or private-account information in URLs or search terms.
- Media links point to upstream X/FxTwitter CDNs. Fetching those links is outside x.md's cache and privacy boundary.

x.md is read-only and does not accept X credentials, post content, or account mutations. It is the canonical implementation, has no successor, and is not affiliated with X Corp.

## Self-host

```bash
REF=146d116a19c93da81a0ae741c19bc3bd74435229
git init x-md
git -C x-md remote add origin https://github.com/pc-style/x-md.git
git -C x-md fetch --depth 1 origin "$REF"
git -C x-md checkout --detach "$REF"
cd x-md
bun install --frozen-lockfile
cp .env.local.example .env.local
bun run dev
```

The commit pin and lockfile make this a reviewable source snapshot. No signed image, deployment artifact, tag, or release checksum is published yet; update `REF` deliberately.

Optional environment variables:

| Variable | Description |
| --- | --- |
| `CONTEXT_DEV_API_KEY` | Context.dev converter fallback |
| `X_SEARCH_SESSIONS_JSON` | Own X sessions for `/search` when FxTwitter is down: `[{"id":"a","authToken":"…","ct0":"…"}]`. Locally, `accounts.local.json` (see `accounts.example.json`) is read instead. Budgeted to 100 calls per session per 15 min |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Optional Upstash/Vercel KV REST endpoint for shared rate-limit counters (`/search` allows 75 live, uncached lookups per minute per IP). Falls back to per-instance memory |
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
