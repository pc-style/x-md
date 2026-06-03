---
name: read-x-links-vercel
description: >-
  Converts public X (Twitter) post URLs to Markdown via the x.md API at
  x.pcstyle.dev (FxTwitter + syndication). Use when the user shares x.com or
  twitter.com status links and you should not run a local repo.
allowed-tools:
  - Bash(skills/read-x-links-vercel/scripts/read-x.sh *)
  - Bash(curl *x.pcstyle.dev*)
---

# Read X links (x.pcstyle.dev)

**API base:** `https://x.pcstyle.dev`

## Quick start

```bash
./skills/read-x-links-vercel/scripts/read-x.sh \
  "https://x.com/handle/status/1234567890"
```

Or:

```bash
curl -sS -G "https://x.pcstyle.dev/api/convert" \
  --data-urlencode "url=https://x.com/handle/status/123" \
  -H "Accept: text/markdown"
```

By default, reply chains are expanded from the root post through the URL you pass (`thread=full`). Use `thread=off` for a single post only.

Path rewrite:

```text
GET https://x.pcstyle.dev/:handle/status/:id
```

## Setup

| Variable | Default | Purpose |
| --- | --- | --- |
| `X_MD_API_BASE` | `https://x.pcstyle.dev` | Override API origin |

## Limits

Public deploy has no Firecrawl. On `syndication_error`, use **read-x-links-local**.
