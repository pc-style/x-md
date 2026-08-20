---
name: browse-x
description: >-
  Reads public X (Twitter) statuses and conversations, profiles, search results,
  followers, and following through x.pcstyle.dev. Use when an agent needs X
  content as compact or full Markdown or JSON without cloning a repository.
allowed-tools:
  - Bash(bun skills/browse-x/scripts/browse-x.ts *)
  - Bash(curl *x.pcstyle.dev*)
---

# Browse X through x.pcstyle.dev

Use the hosted, read-only API. It needs no repository checkout, Bun install, X
login, cookies, or API key. Only public X content is available.

## Read statuses and conversations

```bash
bun skills/browse-x/scripts/browse-x.ts \
  "https://x.com/handle/status/1234567890"

bun skills/browse-x/scripts/browse-x.ts status \
  "https://x.com/handle/status/1234567890" \
  --thread full --context full --replies top --userinfo author --full
```

The default is a compact Markdown conversation (`thread=full`), including the
parent context and selected replies. Use `--thread off` for one status,
`--thread 20` to cap the conversation, `--context thread` for only the direct
author chain, or `--replies recent|off` to change reply inclusion.

The equivalent API request is:

```bash
curl -sS -G "https://x.pcstyle.dev/api/convert" \
  --data-urlencode "url=https://x.com/handle/status/1234567890" \
  --data-urlencode "thread=full" -H "Accept: text/markdown"
```

Direct status rewrites also work at
`https://x.pcstyle.dev/:handle/status/:id`.

## Browse profiles and people

```bash
bun skills/browse-x/scripts/browse-x.ts profile @handle --limit 20
bun skills/browse-x/scripts/browse-x.ts "https://x.com/handle" --full
bun skills/browse-x/scripts/browse-x.ts followers handle --limit 50
bun skills/browse-x/scripts/browse-x.ts following handle --page 2 --full
```

Profiles return profile details and original recent posts. The upstream API
does not expose pinned-post markers. Followers and following return users. `--full` adds metrics, dates,
descriptions, and counts; compact Markdown is the default.

## Search and pagination

```bash
bun skills/browse-x/scripts/browse-x.ts search "from:handle release" --feed latest
bun skills/browse-x/scripts/browse-x.ts search "typescript" --feed media --page 3 --limit 10
bun skills/browse-x/scripts/browse-x.ts search "typescript" --cursor '<opaque cursor>'
```

Search feeds are `latest` (default), `top`, and `media`. `--page` walks from the
first page and is capped at 10; `--limit` is capped at 50. Prefer the opaque
cursor from the Markdown `Continue` link or JSON `nextCursor` for reliable
continuation. When a cursor is supplied, the API fetches that continuation
directly and ignores page walking.

## Output, source, and video

- Markdown is compact by default. `--full` expands metadata, while `--format
  obsidian` adds frontmatter and post headings for statuses.
- `--json` returns the complete response object rather than extracting its
  Markdown field. Use JSON when an agent needs structured posts, users, media,
  `nextCursor`, warnings, or the status `source` provider.
- Status responses expose the fetch provider in JSON `source` and the
  `X-Source` header. Add `--headers` to print response headers before the body;
  it also exposes `X-Cache`, status count, and browse resource metadata.
- Video isn't downloaded or transcoded. Markdown preserves video/media links
  supplied by the source, while JSON preserves the structured media and source
  URLs an agent should inspect or hand to a separate downloader.
- `--nocache` bypasses the hosted cache. Set `X_API_BASE` (or legacy
  `X_MD_API_BASE`) only when testing another compatible deployment.

## Errors and limits

The helper exits 2 for invalid CLI usage and 1 for network or non-2xx API
responses, printing the API error body to stderr. Private, deleted, gated, or
unavailable posts can't be read. Fallback sources can omit conversation posts,
articles, quotes, or media; check JSON `warnings` and `source` rather than
inventing missing content.
