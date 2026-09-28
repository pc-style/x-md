---
name: import-x-history
description: "Imports an X (Twitter) account's post history in bulk through x.pcstyle.dev: hundreds to thousands of posts in one request, replies and reposts included, JSON or NDJSON, with per-account archiving for repeat requests. Use when onboarding a user from their X handle, building a writing-style or memory profile from someone's posts, or when you need more than one page of an account's timeline. No key needed; a key raises the import allowance. Read-only."
allowed-tools:
  - Bash(curl *x.pcstyle.dev*)
---

# import x history

one request, one handle, as much history as you ask for. base URL `https://x.pcstyle.dev` (`https://mdfromx.com` is the same service). no key is needed: anonymous imports are metered per address, **10 per 15 minutes**. the default keyed allowance is **60 per 15 minutes per key**, but issued keys can have an override; read `RateLimit-Policy`; send it as:

```
Authorization: Bearer $X_MD_API_KEY
```

if the key is in the environment as `X_MD_API_KEY`, use it and never print it. a self-hosted deployment in private mode (`X_MD_REQUIRE_API_KEY`) answers `401 unauthorized` without one.

## the one call you need

```bash
curl -sS -H "Authorization: Bearer $X_MD_API_KEY" \
  "https://x.pcstyle.dev/api/v1/profiles/paulg/posts?since=2025-09-01&max_posts=2000"
```

response: `{ "profile": {...}, "posts": [...], "meta": {...} }`

- `posts` — newest first, raw upstream fields untouched: `id`, `text`, `created_at`, `author`, `replying_to`, `quote`, `reposted_by`, `media`, `poll`, `likes`, `replies`, `retweets`, `quotes`, `views`, `bookmarks`, `url`
- `meta.count`, `meta.oldest`, `meta.newest` — what you got
- `meta.truncated` — `true` when capped or incomplete; continue with `until=<meta.next_until>`, preserving `since` and deduplicating IDs. If `meta.warnings` is present, retry the same range before advancing
- `meta.floor_reached` — `true` when accessible history was exhausted, including reaching account creation. This does not prove all published posts are available
- `meta.archive.served` / `.added` — archive entries read versus entries fetched/written; added includes overlaps and updates, not just new unique IDs

## parameters

| param | default | use |
|---|---|---|
| `since` | — | oldest post, `2025-01-01` / ISO datetime / unix seconds. omit for everything available |
| `until` | now | newest post, inclusive |
| `max_posts` | 500 | up to 5000, newest first |
| `with_replies` | true | the account's replies (tone, opinions, short-form style) |
| `with_reposts` | true | reposts come back as the original post with `reposted_by` set and the original's date |
| `only_replies` | false | replies only |
| `format` | json | `ndjson` emits the final sorted selection as `{"post":…}` lines, then one `{"meta":…,"profile":…}` line (or `{"error":…}`) |
| `concurrency` | 16 | up to 32; honor `Retry-After` on busy or throttled responses |
| `refresh` | false | re-walk the range for fresh engagement counts instead of serving the archive |
| `index` | false | `true` returns only what is archived for the handle. free, no walk |

## the archive, and how to use it well

the service stores what it walks per handle. the next import of that handle only fetches the gap (newer than the archive, or older when `since` moves back), then serves everything from the archive. that is why:

- repeat requests can reuse archived posts; timing depends on the account, requested range, upstream health and missing coverage
- for an onboarding slider (3 months → 1 year → everything), just call again with the wider `since`; only the extra months are walked
- check `?index=true` first when you only need to know whether history exists and how far back it goes:

```bash
curl -sS -H "Authorization: Bearer $X_MD_API_KEY" \
  "https://x.pcstyle.dev/api/v1/profiles/paulg/posts?index=true"
# {"handle":"paulg","archive":{"count":1166,"oldest":"…","newest":"…","covered_since":"…","covered_until":"…","floor_reached":false,…},"persistent":true}
```

archived posts keep the engagement counts from when they were stored. pass `refresh=true` when likes/views must be current.

## NDJSON output

```bash
curl -sN -H "Authorization: Bearer $X_MD_API_KEY" \
  "https://x.pcstyle.dev/api/v1/profiles/paulg/posts?since=2026-01-01&format=ndjson"
```

post lines are buffered until the final selection is known, newest first, matching JSON. Require the trailing `meta` line; an `error` line or missing metadata means failure. HTTP headers may already be 200, so inspect the stream error code and retry_after.

## limits and errors

- imports are metered on their own: **10 per 15 minutes per address** without a key (`import-ip` in `RateLimit-Policy`), **60 per 15 minutes per key by default** with one (issued-key overrides are advertised in headers) (`import-key`); one unit per import however many posts it returns. `index=true` is free
- every response carries `RateLimit` / `RateLimit-Policy`; pace against them instead of discovering `429`
- errors are RFC 9457 problem JSON with a machine `code`:
  - `401 unauthorized` / `invalid_key` — missing required key or invalid/disabled key
  - `400 invalid_option` — bad date, `since` ≥ `until`, or a count out of range
  - `404 not_found` — unknown, suspended or protected account
  - `429 rate_limited` — wait `Retry-After` seconds
  - `503 import_busy` — fresh-walk or per-handle capacity is occupied; import allowance is refunded, ordinary request quota still applies
  - `503 upstream_rate_limited` / `upstream_unavailable` — wait at least `Retry-After`, add jitter, then retry the identical request at most twice
- two fresh walks are admitted across the hosted service; queue demand. This is an admission limit, not a throughput guarantee
- repost timestamps describe the original post, not the repost event; use profile cursor pagination when timeline position matters

## what else is there

the same base URL (and key, if you have one) works on the rest of the read API — a single post or thread (`/api/v1/posts?url=…`), a profile page with `limit` up to 100 (`/api/v1/profiles/{handle}?with_replies=true&limit=100&format=json`), search with `since`/`until` (`/api/v1/search?q=…`), followers/following. full reference: `https://x.pcstyle.dev/openapi.json`, guide: `https://x.pcstyle.dev/docs/bulk-import`.

read-only: this never posts, follows, or reads protected accounts, DMs or Lists.
