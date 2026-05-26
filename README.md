# x.md

Open-source API and landing page that turns public **X posts into Markdown** you can save, search, and pipe into agents. Self-host on [Vercel](https://vercel.com) with no paid X API keys required for the default path.

**Not affiliated with X Corp.**

## Features

- **Markdown** and **Obsidian** (`?format=obsidian`) output with YAML frontmatter
- **Threads** (`?thread=full` or `?thread=2-100`)
- **Author metadata** (`?userinfo=author` or `all`)
- **X Articles** when the primary provider returns article blocks
- **Provider chain**: FxTwitter (primary), X syndication CDN (fallback), optional [Firecrawl](https://firecrawl.dev) scrape
- **Response header** `X-Source`: `fxtwitter` | `syndication` | `firecrawl`
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

Cursor agents can read X links via bundled skills:

| Skill | Location | How |
| --- | --- | --- |
| Local CLI | `skills/read-x-links-local/` | `bun run read-x -- "<url>"` |
| Hosted API | `skills/read-x-links-vercel/` | `https://x.pcstyle.dev/api/convert?url=...` |

Live site: [https://x.pcstyle.dev](https://x.pcstyle.dev)

Personal copies (with helper scripts): `~/.agents/skills/read-x-links-local/` and `read-x-links-vercel/`.

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
| `thread` | `off` | `off`, `full`, `2-100` |
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
| `FIRECRAWL_API_KEY` | No | Firecrawl scrape fallback when FxTwitter and syndication fail (local/self-host only; not set on the public Vercel production deploy) |
| `CACHE_TTL_SECONDS` | No | Converter cache TTL (default `3600`) |
| `CACHE_DISABLED` | No | Set to `1` to disable cache |
| `CACHE_PERSIST` | No | Set to `0` to use memory-only cache |

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fpc-style%2Fx-md)

```bash
bun run build
vercel link
vercel env pull .env.local   # optional: pull from Vercel
# add secrets on Vercel dashboard or: vercel env add FIRECRAWL_API_KEY
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
