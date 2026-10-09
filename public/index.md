---
title: "x.md — read public X posts as Markdown"
description: "Read public X posts, videos, threads, profiles, search results, followers, and following as compact Markdown or structured JSON. Read-only, no API key required, open source."
canonical: https://mdfromx.com/
last-updated: 2026-09-08
---

# x.md

> x.md turns public X (Twitter) content into compact Markdown an agent can read.
> Swap `x.com` for `mdfromx.com` in any public post URL. No account and no API
> key required, read-only, MIT-licensed.

## Quick start

```sh
curl https://mdfromx.com/trq212/status/2052809885763747935
```

The same path you would open on x.com, answered as `text/markdown`.

## When to use x.md

- An agent needs the text of a public X post, thread, or X Article and cannot run a browser.
- You are resolving an `x.com` or `t.co` link found in a document, issue, or chat log.
- You want a profile's recent original posts without holding X credentials.
- You are checking who a public account follows, or who follows it.
- You need X search results as structured data rather than a rendered timeline.
- You are saving a post into notes or a vault (`?format=obsidian` adds YAML frontmatter).

## When not to use x.md

- Anything that writes: x.md never posts, replies, follows, likes, or bookmarks.
- Private, protected, suspended, or deleted accounts and posts — these are never available.
- X Lists, direct messages, and analytics — not supported.
- Bulk or firehose collection — the service is rate limited and cached for interactive use.

## Read routes

- Post, video, thread, or conversation: `https://mdfromx.com/{handle}/status/{id}`
- Profile and latest original posts: `https://mdfromx.com/{handle}`
- Search public posts or users: `https://mdfromx.com/search?q={query}`
- Followers: `https://mdfromx.com/{handle}/followers`
- Following: `https://mdfromx.com/{handle}/following`

The versioned machine surface mirrors these at `https://mdfromx.com/api/v1/*`.

## Response formats

Compact Markdown by default. Add `?full=true` for dates, metrics, and richer profile
detail; `?format=obsidian` for YAML frontmatter; `?format=json` or
`Accept: application/json` for structured JSON carrying both the rendered Markdown and
the raw post data. Errors are RFC 9457 problem documents with a stable `code` and a
`resolution` hint.

## What survives conversion

Full reply chains, quoted posts nested inline, images and direct video URLs with their
variants, X Articles with their headings and lists, and a source URL for every post.

## Agent resources

- [Documentation](https://mdfromx.com/docs)
- [OpenAPI description](https://mdfromx.com/openapi.json)
- [MCP server](https://mdfromx.com/mcp)
- [llms.txt](https://mdfromx.com/llms.txt) and [llms-full.txt](https://mdfromx.com/llms-full.txt)
- [Agent skill](https://mdfromx.com/.well-known/agent-skills/index.json)
- [Resource catalog](https://mdfromx.com/.well-known/ard.json)
- [Source](https://github.com/pc-style/x-md)

## Scope

x.md reads public content only and is not affiliated with X Corp.
