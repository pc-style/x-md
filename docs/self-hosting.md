---
title: Self-hosting
description: Run the service and its documentation from the same Vercel project.
sidebar:
  order: 8
---

## Run locally

```bash
git clone https://github.com/pc-style/x-md.git
cd x-md
bun install
bun run dev
```

The Vite server runs the landing page and local API handlers. Run `bun run docs:dev` separately for the Blume documentation server.

## Build and deploy

```bash
bun run build
vercel --prod
```

The build generates Blume docs, then the Vite landing page into `dist`. The included Vercel configuration serves `/docs`, the static assets, and the API rewrites together.

## Search sessions

Latest and Top try FxTwitter, then configured X sessions, then an optional Firecrawl web fallback. Photos, Videos, and Users use configured X sessions directly.

Set `X_SEARCH_SESSIONS_JSON` to an array of account records with `id`, `authToken`, and `ct0`. For local development, use the gitignored `accounts.local.json`; see `accounts.example.json`. Keep account credentials out of version control.

Each session has a **100-call allowance per 15 minutes**, shared across post and user searches. Failed attempts and page walks count. Accounts that return authentication failures are disabled in the current process; rate-limited accounts cool down for 15 minutes. Session health is per instance.

## Shared counters

Attach Upstash Redis through the Vercel marketplace or CLI. The service automatically uses either environment-variable pair:

- `KV_REST_API_URL` and `KV_REST_API_TOKEN`
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`

These share IP and account counters across instances. Without them, counters fall back to process memory. Counter-store failures allow requests through; they do not take the API down. Redeploy after connecting environment variables.

## Optional configuration

| Variable | Purpose |
| --- | --- |
| `FIRECRAWL_API_KEY` | Conversion fallback and degraded Latest/Top search |
| `CONTEXT_DEV_API_KEY` | Additional post-conversion fallback |
| `CACHE_TTL_SECONDS` | Cache lifetime; default 3600 |
| `CACHE_DISABLED` | Disable application caching |
| `CACHE_PERSIST` | Control persistent application caching |

FxTwitter is the primary conversion provider, followed by X syndication and configured fallbacks. Inspect `X-Source` when diagnosing a response.
