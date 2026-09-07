---
name: browse-x
description: Read public X (Twitter) posts, threads, profiles, search, followers, or following via x.pcstyle.dev, as Markdown or JSON.
allowed-tools:
  - Bash(bun skills/browse-x/scripts/browse-x.ts *)
  - Bash(curl *x.pcstyle.dev*)
---

# browse X

Hosted read-only API at x.pcstyle.dev. The local helper requires Bun, but needs no X login, cookies, or API key. Public content only. Install elsewhere with the skills CLI (`bunx skills add pc-style/x-md`).

```bash
bun skills/browse-x/scripts/browse-x.ts "https://x.com/handle/status/123"
bun skills/browse-x/scripts/browse-x.ts status "https://x.com/handle/status/123" --thread 20 --context thread --replies top --userinfo author --full
bun skills/browse-x/scripts/browse-x.ts profile @handle --limit 20
bun skills/browse-x/scripts/browse-x.ts followers handle --limit 20
bun skills/browse-x/scripts/browse-x.ts following handle --page 2 --full
bun skills/browse-x/scripts/browse-x.ts search "from:handle release" --feed latest
bun skills/browse-x/scripts/browse-x.ts search "typescript" --feed media --page 3 --limit 10
bun skills/browse-x/scripts/browse-x.ts search "typescript" --cursor "<nextCursor>"
```

Status options: `--thread` is `full` (default), `off`, `conversation`, or 2-100. `--context` is `full` or `thread` (direct author chain). `--replies` is `top`, `recent`, or `off`. `--userinfo` is `off`, `author`, or `all`. Search `--feed` is `latest` (default), `top`, `photos`, `videos`, or `users` (`media` aliases `photos`).

Direct API: `curl -sS -G https://x.pcstyle.dev/api/convert --data-urlencode "url=https://x.com/handle/status/123" -H "Accept: text/markdown"`, or rewrite a status URL to `https://x.pcstyle.dev/:handle/status/:id`.

- `--full` expands metadata. `--json` returns the whole response (posts, users, media, `nextCursor`, `warnings`, `source`). `--format obsidian` (status only) adds frontmatter. `--headers` prints a normalized status line and response headers. `--nocache` bypasses the cache.
- `--page` caps at 10, `--limit` at 20. Prefer the opaque cursor for continuation.
- Profiles return details and recent original posts. The upstream API exposes no pinned-post markers; don't invent them.
- Video isn't downloaded; links are preserved.
- Exit 2 is bad usage, 3 is rate limited (a `Retry-After` header/seconds is printed — wait that long before retrying), 1 is any other network or API error. Private, deleted, or gated posts can't be read. Fallback sources may omit replies, quotes, or media; check `warnings` instead of inventing content.
