# x.md

Open-source API and landing page that turns public **X posts into Markdown** you can save, search, and pipe into agents. Self-host on [Vercel](https://vercel.com) with no paid X API keys required for the default path.

**Not affiliated with X Corp.**

## Features

- **Markdown** and **Obsidian** (`?format=obsidian`) output with YAML frontmatter
- **Threads** (default `full`): conversation ancestors and author continuations; use `?thread=off` for a single post only
- **Author metadata** (`?userinfo=author` or `all`)
- **X Articles** when the primary provider returns article blocks
- **Provider chain**: FxTwitter (primary), X syndication CDN (fallback), optional [Context.dev](https://context.dev) and [Firecrawl](https://firecrawl.dev) scrape
- **Response header** `X-Source`: `fxtwitter` | `syndication` | `contextdev` | `firecrawl`
- **CORS** enabled on `/api/*` for browser and agent use

## Quick start

```bash
git clone https://github.com/pc-style/x-md.git
cd x-md
bun install
cp .env.local.example .env.local
bun run dev
```

Open [http://localhost:5173](http://localhost:5173), paste a public status URL, or call the API directly.

## Agent skills

Cursor agents can read X links via bundled skills. Install with the [skills CLI](https://skills.sh/):

```bash
bunx skills add pc-style/x-md --list

bunx skills add pc-style/x-md -g -y \
  --skill read-x-links-vercel --skill read-x-links-local
```

| Skill | Use when |
| --- | --- |
| `read-x-links-vercel` | Hosted API at `x.pcstyle.dev` — no local repo |
| `read-x-links-local` | Full threads, optional Context.dev/Firecrawl fallbacks, working in this repo |

Live site: [https://x.pcstyle.dev](https://x.pcstyle.dev)

## API

### Convert by query string

```bash
curl -sS -H "Accept: text/markdown" \
  "http://localhost:5173/api/convert?url=https%3A%2F%2Fx.com%2Fhandle%2Fstatus%2F123"
```

### Path-style URLs (Vercel rewrites)

```text
GET /:handle/status/:id
```

Same query params as below.

### Query parameters

| Param | Default | Values |
| --- | --- | --- |
| `url` | — | Encoded X status URL (required on `/api/convert`) |
| `format` | `markdown` | `markdown`, `obsidian` |
| `thread` | `full` | `off`, `full`, `conversation`, `2-100` |
| `userinfo` | `off` | `off`, `author`, `all` |
| `nocache` | — | Bypass cache when set |

### JSON responses

```bash
curl -sS -H "Accept: application/json" \
  "http://localhost:5173/api/convert?url=..."
```

Returns Markdown in `body` plus `source` and cache metadata.

## Environment variables

Copy [`.env.local.example`](.env.local.example) to `.env.local`:

| Variable | Required | Description |
| --- | --- | --- |
| `CONTEXT_DEV_API_KEY` | No | Context.dev Markdown scrape fallback when FxTwitter and syndication fail (local/self-host only by default) |
| `FIRECRAWL_API_KEY` | No | Firecrawl scrape fallback when FxTwitter, syndication, and Context.dev fail (local/self-host only by default) |
| `CACHE_TTL_SECONDS` | No | Converter cache TTL (default `3600`) |
| `CACHE_DISABLED` | No | Set to `1` to disable cache |
| `CACHE_PERSIST` | No | Set to `0` to use memory-only cache |

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpc-style%2Fx-md)

```bash
bun run build
vercel link
vercel env pull .env.local   # optional: pull from Vercel
# add secrets on Vercel dashboard or:
vercel env add CONTEXT_DEV_API_KEY
vercel env add FIRECRAWL_API_KEY
vercel --prod
```

`vercel.json` sets build output to `dist`, API routes under `api/`, and path rewrites for `/:handle/status/:id`.

Production domain: `https://x.pcstyle.dev` (canonical URLs and OG tags in `index.html`).

**DNS (Cloudflare or your provider):** `A` record `x` → `76.76.21.21` (Vercel).

## Project layout

```text
api/convert.ts     Vercel serverless handler
lib/               Fetch providers, markdown rendering, cache
src/               Vite landing page
public/            Static assets, robots.txt, sitemap.xml
```

## License

[MIT](LICENSE)

## Premium monetization setup

The basic converter remains free and anonymous. Premium modes are gated by Clerk auth or user API keys, Convex audit/API-key storage, and Autumn entitlements backed by Stripe.

Plans and credits:

| Plan | Price | Included |
|---|---:|---|
| Free | $0/mo | Basic anonymous X Markdown conversion, social link bundle, conversation map, media manifest |
| Starter | $5/mo | 250 social credits/mo, Obsidian templates, quote expansion, JSON-LD basic export |
| Pro | $15/mo | 1,500 social credits/mo, thread briefing, author dossiers, cross-platform parser, context-window safe mode, bulk JSON-LD |

Premium feature costs:

| Feature | Credits | API mode |
|---|---:|---|
| Quote-post expansion | 1 | `premium=quote_expansion` |
| Obsidian social note templates | 1 | `premium=obsidian_templates` |
| Thread briefing mode | 3 | `premium=thread_briefing` |
| Context-window safe mode | 3 | `premium=context_safe_mode` |
| Cross-platform social parser | 3 | `premium=cross_platform_parser` |
| Social archive JSON-LD bulk/export | 5 | `premium=jsonld_bulk_export` |
| Author dossier | 10 | `premium=author_dossier` |

Required env vars for the premium stack:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=
CLERK_SECRET_KEY=
CONVEX_DEPLOYMENT=
NEXT_PUBLIC_CONVEX_URL=
AUTUMN_SECRET_KEY=
AUTUMN_WEBHOOK_SECRET=
```

Autumn is the source of truth for plans, feature credits, checkout, customer portal, and Stripe subscription state. Do not create or mutate Stripe products/prices/subscriptions directly for this flow; configure plans/features in Autumn and let Autumn sync Stripe.

Premium API flow:

1. Resolve auth from Clerk bearer token or `Authorization: Bearer xmd_...` API key.
2. Mirror the Clerk user into Convex and get/create the Autumn customer with the Clerk user ID as `customerId`.
3. For premium work, call Autumn `customers.check` with `featureId: "social_credits"`, `requiredBalance`, and `sendEvent: true` before doing expensive work.
4. Return `401` for missing auth and stable `402` paywall responses when Autumn denies allowance.
5. Log request and feature-run records in Convex when configured.

Account endpoints:

- `POST /api/billing?plan=starter|pro` starts Autumn checkout.
- `POST /api/billing?action=portal` opens the Autumn/Stripe customer portal.
- `GET /api/api-keys` lists hashed API-key records for the authenticated user.
- `POST /api/api-keys` creates an `xmd_...` API key and stores only its SHA-256 hash in Convex.
- `DELETE /api/api-keys` revokes by `keyHash` or plaintext `apiKey`.
- `POST /api/autumn-webhook` verifies the raw body with `AUTUMN_WEBHOOK_SECRET` before accepting webhook events.

Deploy Convex separately as part of release setup:

```bash
bunx convex dev      # initial link/codegen
bunx convex deploy   # production Convex functions/schema
```

