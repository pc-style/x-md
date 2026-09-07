# Contributing

Thanks for helping. x.md is a small read-only API, so most contributions are provider fixes, output improvements, and docs.

## Setup

```bash
bun install --frozen-lockfile
cp .env.local.example .env.local
bun run dev          # landing page + API handlers on Vite
bun run docs:dev     # documentation site (separate server)
```

Bun `1.4.x` is the supported toolchain (see `.bun-version`). The Vite dev server mirrors the Vercel routing in `vercel.json`, so `/handle/status/id`, `/search`, and `/api/*` work locally.

## Before you open a PR

```bash
bun --bun tsc
bun run test
bun run build
```

CI runs the same three steps plus a smoke run of the `browse-x` CLI. Keep the lockfile in sync (`bun install` without `--frozen-lockfile` when you change dependencies).

## What makes a good PR

- One change per PR, with the reason in the description.
- Tests for behavior changes. Provider parsing lives in `lib/` and is covered by Vitest with mocked upstream responses.
- Update `docs/` and `README.md` when routes, parameters, or limits change. The docs are the contract.
- Do not commit credentials. `accounts.local.json` and `.env.local` are gitignored; keep it that way.

## Provider changes

FxTwitter and X's syndication endpoint are the default providers. Changes to how upstream data is parsed should come with a fixture-style test that shows the raw shape and the rendered Markdown, so the next upstream change is easy to diagnose.

## Reporting security issues

Use the private vulnerability report form under the repository's Security tab. See `SECURITY.md`.
