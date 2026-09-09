---
title: "x.md for agents"
description: "How an autonomous agent should call x.md: what it is for, the exact routes, the response contract, the limits, and what it will never do."
canonical: https://x.pcstyle.dev/agents.md
last-updated: 2026-09-08
---

# x.md for agents

x.md is a read-only browser for public X (Twitter) content. Give it a public X
URL, handle, or query; it answers with compact Markdown or structured JSON.
Anonymous is the default and needs no account, no API key, and no OAuth; an
optional bearer key, issued by hand, raises the search allowance
([/auth.md](https://x.pcstyle.dev/auth.md)). MIT-licensed, free, best effort.

## When to use x.md

Reach for x.md when the job is reading one piece of public X content right now:

- You have an `x.com`, `twitter.com`, or `t.co` link from an issue, changelog,
  or chat log and need its text inline, without a browser or an X login.
- You need a public post with its thread, quoted posts, media links, and replies.
- You need a public profile's bio and latest original posts, or who it follows
  and who follows it.
- You need X search results as structured data rather than a rendered timeline.
- You are capturing a post into notes; `?format=obsidian` emits YAML frontmatter.
- You want a JSON tool-call contract: `Accept: application/json`, described by
  [openapi.json](https://x.pcstyle.dev/openapi.json) or the MCP server.

## Call it in one request

```sh
curl -H 'Accept: text/markdown' \
  https://x.pcstyle.dev/trq212/status/2052809885763747935
```

The rule is: take any public `x.com` URL and replace the host with
`x.pcstyle.dev`. Keep the path. `twitter.com` and `t.co` links resolve the same
way once expanded.

## Routes

| Job | Route |
| --- | --- |
| One post, its thread, and its replies | `GET /{handle}/status/{id}` |
| A profile and its latest posts | `GET /{handle}` (add `with_replies=true`, `with_reposts=true`, `limit=100`) |
| An account's whole post history as raw JSON | `GET /{handle}/posts?since={date}&max_posts=2000` |
| Search public posts or accounts | `GET /search?q={query}&feed=latest\|top\|photos\|videos\|users` |
| Who follows an account | `GET /{handle}/followers` |
| Who an account follows | `GET /{handle}/following` |
| oEmbed document for a status URL | `GET /oembed?url={status url}` |

The same reads, versioned and stable for machine callers, live under
`/api/v1/`: `POST`-free, `GET`-only, and described field by field in
[openapi.json](https://x.pcstyle.dev/openapi.json).

```text
GET /api/v1/posts?url={status url}
GET /api/v1/search?q={query}
GET /api/v1/profiles/{handle}
GET /api/v1/profiles/{handle}/posts
GET /api/v1/profiles/{handle}/followers
GET /api/v1/profiles/{handle}/following
```

## Choosing a representation

| You want | Send |
| --- | --- |
| Compact Markdown (default) | nothing, or `Accept: text/markdown` |
| Markdown with dates, metrics, and full profile detail | `?full=true` |
| YAML frontmatter for a notes vault | `?format=obsidian` |
| Structured JSON with the rendered Markdown *and* the raw records | `Accept: application/json` or `?format=json` |

JSON conversion responses carry `url`, `markdown`, `posts`, `compact`,
`warnings`, `postCount`, `source`, `cache`, and `format`. Browse responses carry
the resource-specific `profile`, `posts`, or `users`, plus `page`, `limit`, an
optional `nextCursor`, the rendered `markdown`, and cache status.

Read `warnings` before you summarise. A short reply chain or missing media is
usually an upstream gap, not evidence about the post.

## Pagination

`limit` defaults to 20 and is capped at 20. Continue with the opaque `cursor`
returned as `nextCursor` — one cursor, one upstream page. `page=1` through
`page=10` also works but walks upstream pages and is slower; values above 10 are
clamped. Results can hold fewer items than `limit` because replies and reposts
are filtered after retrieval.

## Limits and failures

- Live search: 5 uncached requests per minute per IP. Cache hits are free.
- Live-provider requests: a further shared allowance per IP per 15-minute
  window. Every feed and every page of a page walk counts as one request.
- `429` carries `Retry-After` in seconds. Wait that long. Do not retry in a
  loop, and do not fan out across IPs.
- `503` with `Retry-After: 30` means an upstream provider is down.
- Errors are RFC 9457 problem documents (`application/problem+json`) with a
  stable machine `code` and a `resolution` hint that says what to do next.
- Successful anonymous responses stay cacheable for about an hour; `X-Cache`
  reports the outcome and `X-Source` names the upstream provider. A keyed
  response is `Cache-Control: private, no-store` and never enters a shared
  cache, though x.md's own result cache still spares the upstream call.

## When not to use x.md

It is read-only, and that is structural rather than a policy setting: there is
no write path in the service.

- No posting, replying, following, liking, bookmarking, or messaging.
- No X credentials accepted from callers, ever. Do not send any.
- No private, protected, suspended, or deleted content.
- No X Lists, direct messages, notifications, home timeline, or analytics.
- No bulk export or firehose. Rate limits are the intended ceiling, not an
  obstacle to route around.
- No SLA, contract, or support commitment, and no guarantee of completeness —
  read `warnings` rather than inferring from what is missing.

Do not put secrets or private-account information in URLs or search terms: the
query you send is forwarded to the upstream public providers.

## Other ways in

- **MCP** — [https://x.pcstyle.dev/mcp](https://x.pcstyle.dev/mcp) exposes the
  same reads as tools, with the server card at `/mcp/server-card`.
- **Agent skill** — `bunx skills add pc-style/x-md -g -y --skill browse-x`
  installs `browse-x`, a CLI wrapper that exits `3` on a rate limit after
  printing `Retry-After`. Index:
  [/.well-known/agent-skills/index.json](https://x.pcstyle.dev/.well-known/agent-skills/index.json).
- **Catalogs** — [/.well-known/ard.json](https://x.pcstyle.dev/.well-known/ard.json)
  lists every machine surface; [/.well-known/api-catalog](https://x.pcstyle.dev/.well-known/api-catalog)
  is the RFC 9727 linkset.
- **Documentation** — [/docs](https://x.pcstyle.dev/docs), indexed for agents at
  [/docs/llms.txt](https://x.pcstyle.dev/docs/llms.txt) and in full at
  [/llms-full.txt](https://x.pcstyle.dev/llms-full.txt).

## Facts about the service

- Authentication: none required. See [/auth.md](https://x.pcstyle.dev/auth.md).
- Price: free. See [/pricing.md](https://x.pcstyle.dev/pricing.md).
- Source: [github.com/pc-style/x-md](https://github.com/pc-style/x-md), MIT.
- Contact: [GitHub issues](https://github.com/pc-style/x-md/issues).
- Not affiliated with X Corp.
