# Agent readiness: state and open items

Getting x.pcstyle.dev to 100/100 on [is-agentic](https://is-agentic.com/scan/x.pcstyle.dev).
Everything here is the leftover; the work itself is on the branch below.

**Status: the code is done and every required check passes. It is not merged, and the score cannot move
until it is.** The PR page shows two red things — a failing `CodeQL` check and a stale
`CHANGES_REQUESTED` review. Both are explained below; neither is a required check, but the review does
block the merge.

## Where it is

- Branch `feat/agent-readiness-100`, PR [#21](https://github.com/pc-style/x-md/pull/21), 8 commits,
  HEAD `99869d1`. All commits are signed.
- `bun --bun tsc`, `bun run test` (541 passing, up from 282 on `main`) and a clean `bun run build` pass.
- Required checks pass: the `build` and `CodeRabbit` status checks, plus a successful deployment to the
  `Preview` environment. Note `Preview` is a deployment rule, not a check — in the PR checks list it
  surfaces as the `Vercel` status, so do not go looking for a check named "Preview".
- `CodeRabbit` returns to `pending` for several minutes after every push or `@coderabbitai review`. A yellow
  required check right after a re-review is normal, not a regression.

Baseline when this started (2026-09-08): **64/100** — Essential 48.9/80, Recommended 13/20, Bonus +2.3 from
11 positive signals, 30 eligible checks. Ora's own raw score was 50/100.

**How the branch was verified:** by hand, against an authenticated preview deployment (`vercel curl`, which
injects a protection-bypass token). The preview has Vercel Authentication on, so **is-agentic and Ora cannot
scan it** — every anonymous request 302s to Vercel SSO. The first real measurement is only possible after
merge and a production deploy. Treat every "now passes" claim below as verified-by-hand, not scored.

## Blocking the merge

1. **Dismiss both stale CodeRabbit reviews.** This is the *only* thing holding the merge: everything else is
   green, `mergeable: MERGEABLE`, branch 0 behind `main`, yet `mergeStateStatus: BLOCKED` and
   `reviewDecision: CHANGES_REQUESTED`.

   The re-review completed at 17:06Z and did **not** clear it — CodeRabbit posted a `COMMENTED` review on
   `99869d1` and left its earlier verdicts standing. **Two** `CHANGES_REQUESTED` reviews are live and both
   need dismissing from the PR page:
   - review `5144662733` on commit `e42521f`
   - review `5144271465` on commit `385985b5`

   Dismissing only the newer one promotes the older into the "latest opinionated review" slot and the
   decision stays `CHANGES_REQUESTED`, which looks like the fix failed.

   Every finding from both reviews is addressed. Its last `COMMENTED` review raises one more, on
   `public/openapi.json` line 7: that "Every operation is a `GET`" is wrong because `/mcp` accepts POST.
   **That one is a false positive** — `/mcp` is not described in the document; its 15 documented operations
   are all GET (`jq '.paths | .. | objects | keys' public/openapi.json` shows only `get`). No change needed.

## Do before re-scanning

2. **Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` on the Vercel project** (or the
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` pair — `lib/redis.ts` accepts either).
   Without them `lib/ratelimit.ts` falls back to a per-process `Map`, so each warm lambda keeps its own
   counters: the effective allowance becomes roughly *limit × warm instances*, and the advertised
   `RateLimit: r=…` overstates how much of the published policy is actually left. Nothing "fails open" here —
   that path only fires on a Redis *error*, and the account-capacity checks in `lib/xsearch.ts` deliberately
   fail **closed**.
3. **Publish `public/server.json` to an MCP registry**, then link the resulting entry from the docs so the
   verification is bi-directional. Two gotchas: `mcp-publisher` reads a `server.json` from the working
   directory, not from `public/`; and its `version` is `1.0.0` from `MCP_SERVER_VERSION` in `lib/mcp.ts`,
   which is the MCP server's own version line and deliberately independent of the package's 1.1.0 — a first
   publish at 1.0.0 is correct, just don't "fix" it to match `package.json`.

   This is **a regression that ships with the feature**: Ora's `mcp-registry-listed` currently reads
   `na — No MCP server detected`, and not-applicable checks are excluded from the denominator. Once a server
   exists it becomes a real `fail` until it is listed. Net strongly positive anyway — see the arithmetic.
4. **Submit the sitemap to Google Search Console and Bing Webmaster Tools.** The homepage was literally
   unindexable before this work (an empty `<div id="app">`), so re-submission is what starts the clock on
   the two search-index checks. They lag days to weeks.

## Then

5. **Trigger a fresh scan at <https://is-agentic.com/scan/x.pcstyle.dev>**, then read it back with
   `npx is-agentic x.pcstyle.dev --json`. **The CLI cannot force a re-scan** — it returns the latest *stored*
   report and only starts one when none exists (its only flags are `--json` and `--help`). Running it
   straight after merging prints the stale 64/100 and looks like the work failed.

## Decide

6. **Three CodeQL alerts are open on the PR ref, so the `CodeQL` check shows `failure`**
   ("3 new alerts including 1 critical severity security vulnerability"). CodeQL is *not* a required check,
   so this does not block. Alert numbers differ between the PR ref and `main`, and dismissing one does not
   dismiss the other.
   - `js/reflected-xss`, `api/oembed.ts` — **pre-existing**; alert **#9** on the PR ref, **#5** on `main`.
   - `js/xss-through-exception`, `lib/apierror.ts` — alert **#10**, new code.
   - `js/request-forgery`, `lib/fxtwitter.ts` — alert **#2**, **the "1 critical"**. Pre-existing on `main`;
     CodeQL re-reports it against the PR because the diff was large enough to pull it into scope. Not
     introduced here.

   The first two are not exploitable: both responses set an explicit `application/json` /
   `application/problem+json` type via `setHeader`, and the site sends `X-Content-Type-Options: nosniff`
   globally. CodeQL flags `res.send(string)` because Express *infers* `text/html` when no type is set; it does
   not model the explicit header. The values are clamped anyway (`echoable` in `lib/embed.ts`, `safeDetail` in
   `lib/apierror.ts`). HTML-escaping inside a JSON body would corrupt legitimate text and `res.json()` would
   clobber the `problem+json` type the error handling depends on — so the honest resolution is to dismiss them
   as false positives, not to write more code.

   `main` also carries `js/xss-through-dom` (`src/main.ts`) and `js/insufficient-password-hash`
   (`lib/apikeys.ts`), both outside this work. **The password-hash one is worth its own look.**

   (Three alerts the branch introduced and then fixed on its way — `js/request-forgery` in `lib/mcp.ts`, and
   two `js/incomplete-url-substring-sanitization` in `lib/discovery.test.ts` — show as `fixed` on the PR ref.
   Not regressions.)
7. **Tag `v1.1.0`.** `package.json` and `CHANGELOG.md` say 1.1.0; `git tag -l` and the remote have only
   `v1.0.0`.

## Left on the table, on purpose

Point values below are **Ora** points unless marked otherwise. Ora exposes 113 bonus points across 55 bonus
checks, while is-agentic's whole bonus pool is small — so "2 Ora bonus points" is nowhere near 2 is-agentic
points. Do not add them to the arithmetic in the next section.

- **`agent-ua-markdown`** (Ora 1, bonus) — would mean serving Markdown to GPTBot/ClaudeBot/ora-agent by
  User-Agent. Skipped: if the scanner fetches the homepage with one of those UAs, `content-no-js` (essential,
  worth ~8.9 **is-agentic** points) would see Markdown instead of the pre-rendered HTML. Bad trade.
- **`a2a-agent-card`** (Ora 2, bonus) — an A2A card at `/.well-known/agent-card.json` declares an endpoint
  answering `message/send` and `tasks/get`. x.md has none, so publishing one would be a false capability
  claim. The honest path is to build a small A2A surface over the MCP tools first.
- **`mcp-multi-surface-coverage`** (Ora 2, bonus) — needs a *second* MCP server dedicated to the docs,
  separate from the product one. Feasible later; blume already emits `/docs/llms.txt`.
- **`x_md_get_post` has no top-level `required`** in its MCP input schema, because it genuinely accepts
  either `url` *or* `handle` + `id` (`anyOf`, `lib/mcp.ts`). A scorer reading `inputSchema.required` literally
  sees 4 of 5 tools. Every alternative either drops the handle+id path or writes a `required` that is not true.
- **Idempotency-Key and async-job checks** are unreachable: both require write endpoints, and x.md is
  read-only by design.

## The arithmetic

is-agentic splits 80 points equally across the eligible Essential checks and 20 across the eligible
Recommended ones; bonus is added on top (it contributed +2.3 at baseline, and the published data states no
explicit cap — do not assume one).

Today that is 9 Essential (80/9 = 8.89 each — which is why `content-no-js` is worth ~8.9) and 21 Recommended
(20/21 = 0.95 each). All 9 essentials are addressed. With **both** search-index checks at zero:
80 + 18.1 = 98.1, needing ~1.9 of bonus.

**But the denominators are not constants** — not-applicable checks are excluded, and shipping the MCP server
makes 15 currently-`na` checks eligible (all reading "No MCP server detected"). Three of those are non-bonus
and land in the scored pool: `mcp-registry-listed`, `mcp-resource-listing`, `mcp-resource-quality`. At 22
eligible Recommended with `mcp-registry-listed` failing, that is 20 × 19/22 = 17.3, so bonus must clear ~2.7.
At 24 eligible with the two resource checks passing (`lib/mcp.ts` does implement `resources/list` and
`resources/read`), 20 × 21/24 = 17.5, needing ~2.5.

All of those are reachable, so the conclusion holds — but **re-derive the split from `score_breakdown` after
the first post-merge scan rather than trusting 21.** The essentials are still the whole game: if a re-scan
lands below 100, look there first, not at the search checks.

## Measuring it

The scorer publishes its own data; use it instead of guessing what a check wants.

```sh
curl 'https://ora.ai/api/checks'                          # all 125 checks: criteria, weights, tiers
curl 'https://ora.ai/api/score/x.pcstyle.dev'             # per-check result with the evidence string
curl 'https://is-agentic.com/api/v1/report?url=https://x.pcstyle.dev'
curl -H 'Accept: text/markdown' https://is-agentic.com/scan/x.pcstyle.dev
```

Each failing check carries a `details` string (the exact evidence) and a `recommendation` (what would pass) —
lowercase JSON keys; the CLI renders them as **Evidence** and **Fix**, and the Markdown scan as **Evidence**
and **Recommended fix**. Read those before changing anything. The biggest find in this work came from one:
`Partial compatibility: 7/7 operationIds, 2/7 typed schemas` was the fingerprint of the docs framework's spec
being served at `/openapi.json` — the committed spec now has 15 operations.
