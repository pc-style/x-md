---
name: read-x-links-local
description: >-
  Converts public X (Twitter) post URLs to Markdown using this repo's bun CLI
  (FxTwitter, syndication, optional Firecrawl). Use when the user shares
  x.com/twitter.com status links in this project or needs full threads and
  local fallbacks.
allowed-tools:
  - Bash(bun scripts/read-x.ts *)
  - Bash(bun run read-x *)
  - Bash(skills/read-x-links-local/scripts/read-x.sh *)
---

# Read X links (local — this repo)

Run from the **x-md** workspace root.

## Quick start

```bash
bun run read-x -- "https://x.com/handle/status/1234567890"
```

By default, reply chains are expanded from the root post through the URL you pass (`thread=full`). Use `--thread off` for a single post only.

Or:

```bash
bun scripts/read-x.ts "https://x.com/handle/status/1234567890" --userinfo author
```

Helper script (from repo root):

```bash
./skills/read-x-links-local/scripts/read-x.sh "https://x.com/handle/status/1234567890"
```

## Setup

```bash
bun install
cp .env.local.example .env.local   # optional FIRECRAWL_API_KEY
```

Set `X_MD_ROOT` to this repo if calling the script from elsewhere.

## Options

See [scripts/read-x.ts](../../scripts/read-x.ts): `--format`, `--thread`, `--userinfo`, `--json`, `--nocache`, `--out`.

## Hosted API

For network-only reads, use **read-x-links-vercel** (`skills/read-x-links-vercel/`).
