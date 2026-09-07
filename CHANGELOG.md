# Changelog

Notable changes to x.md. Versions are git tags on `main`; the hosted API at x.pcstyle.dev always runs the latest tagged release.

## 1.0.0 - 2026-09-07

First tagged release. Everything below is live on the hosted API.

- Post conversion: `GET /:handle/status/:id` and `GET /api/convert` return compact Markdown, Obsidian Markdown, or JSON with conversation context, threads, replies, media, and video variants.
- Browse: profiles, followers, following, and search (`latest`, `top`, `photos`, `videos`, `users`) with cursor and bounded page pagination.
- Chat previews: Discord, Telegram, and Slack bots get Open Graph embed HTML and a `/oembed` document.
- `browse-x` agent skill with a cross-platform TypeScript CLI (`bun skills/browse-x/scripts/browse-x.ts`). It prints `Retry-After` and exits with code 3 on a rate limit so agents can back off precisely.
- Custom-built live search provider behind Photos, Videos, Users, and the Latest/Top fallback, with a fixed allowance of 10 requests per IP per 15 minutes drawn from a shared public pool. Rejected requests are refunded so capacity that frees up later in the window stays usable. `429` responses always carry `Retry-After`.
- People search fix: patched `@the-convocation/twitter-scraper` so `users` results read `name`, `screen_name`, avatar, and join date from X's newer `core`/`avatar` fields instead of returning `@unknown`.
- Shared Upstash/Vercel KV counters and state, with an in-memory fallback for local development.
- Vercel Web Analytics on the landing page, docs, and admin page.
- Documentation site at `/docs` (Blume MDX) covering routes, parameters, limits, caching, privacy boundaries, and self-hosting.
- Repository hygiene: CI type-checks, tests, and builds on every PR; Dependabot for Bun and Actions; CodeQL; issue and PR templates; `CONTRIBUTING.md` and `SECURITY.md`; protected `main`.
