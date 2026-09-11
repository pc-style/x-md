# Changelog

Notable changes to x.md. Versions are git tags on `main`; the hosted API at x.pcstyle.dev always runs the latest tagged release.

## 1.1.1 - 2026-09-11

- fixed mcp pagination rejecting continuation cursors longer than 1,024 characters. clients can now pass long `next_cursor` values back unchanged.

## 1.1.0 - 2026-09-08

An agent-readiness release. Nothing in 1.0.0 changed behaviour; everything below is additive, and the routes that got a new name kept their old one.

- **Versioned API surface.** `/api/v1/posts`, `/api/v1/profiles/{handle}` (plus `/followers` and `/following`), `/api/v1/search`, and `/api/v1/oembed` are the stable machine paths. The permalink routes (`/{handle}`, `/{handle}/status/{id}`, `/search`, `/oembed`) are unchanged and remain the unversioned product surface.
- **Deprecation policy, published and signalled.** `/api/convert` and `/api/browse` are deprecated aliases with a 2027-09-15 sunset. They answer exactly as before and add the RFC 9745 `Deprecation` header, the RFC 8594 `Sunset` header, and a `Link` with `rel="successor-version"`. The policy, including the 12-month minimum support window for a major version, is written down at `/docs/versioning` and repeated machine-readably in `x-api-lifecycle` in the OpenAPI document and in `/api`.
- **RFC 9457 problem details for every failure.** Errors are `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, a stable machine `code`, a `resolution` hint, and `documentation_url`. The `error` field is kept as an alias of `detail` for clients written against the old shape. Every code is catalogued at `/docs/errors`.
- **Rate-limit response headers.** Responses carry the IETF `RateLimit-Policy` and `RateLimit` structured fields, the `RateLimit-Limit`/`-Remaining`/`-Reset` compatibility triple for the tightest policy, and `Retry-After` on `429` and `503`, so a client can pace itself instead of discovering a limit by hitting it. The quotas themselves are unchanged.
- **OpenAPI 3.1 description** at `/openapi.json`, generated from the same TypeScript that implements the API, covering every route, parameter, response schema, error body, quota, and pagination field.
- **MCP server** at `/mcp` over Streamable HTTP, exposing the same read-only routes as tools, with a server card at `/.well-known/mcp/server-card.json`.
- **Markdown content negotiation.** `Accept: text/markdown` on the landing page and the documentation returns the Markdown twin of the page; `?mode=agent` does the same without a header, an unsatisfiable `Accept` gets a `406`, and every response advertises the alternate with an RFC 8288 `Link` header and `Vary: Accept`.
- **The landing page is pre-rendered**, so its content is readable without running JavaScript.
- **Discovery documents:** `/llms.txt`, `/llms-full.txt`, `/agents.md`, `/auth.md`, `/pricing.md`, a JSON API index at `/api`, an RFC 9727 API catalog at `/.well-known/api-catalog`, and an Agentic Resource Discovery catalog at `/.well-known/ard.json`.
- **Agent-friendly 404s.** An unknown path answers with a recovery document — HTML, Markdown, or problem JSON depending on `Accept` — listing the routes that do exist.
- **Documentation:** new pages for [versioning and deprecation](https://x.pcstyle.dev/docs/versioning), the [error catalogue](https://x.pcstyle.dev/docs/errors), and the [MCP server](https://x.pcstyle.dev/docs/mcp); the pagination, response, and limit references were rewritten against the code.

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
