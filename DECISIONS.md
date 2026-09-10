# DECISIONS — merge/x-md-fast (x-md-fast into x-md, both domains)

## what this branch is
- `main` (e0672c8, includes #26 mdfromx.com domain pages) + the `/simplify` cleanup (7ddf275) + `feat/bulk-profile-import` (8013d5a = pc-style/x-md-fast main, PR #25) + the domain follow-ups below.
- x-md-fast is not a separate codebase: it is x-md's PR #25 branch with 24 commits on top of 2f5265f. "Merge the projects" = git merge. Only conflict was theme.css (logo selector); kept the positional selector from the simplify commit.
- Adam's instruction: keep the new stuff; report logic/auth/behavior conflicts rather than silently change them.

## domains
- #26 already made mdfromx.com work by building a `dist/_domains/mdfromx` text-replaced variant of every static page and rewriting by host in `middleware.ts`. Source of truth stays `x.pcstyle.dev`; the build derives the mdfromx.com copy. Do not hand-edit docs to the new domain.
- This branch fixes what #26 left dynamic and hardcoded: MCP server card / discover / resources (`lib/mcp.ts` takes a `site`), 404 recovery links (`lib/notfound.ts` derives the origin from `instance`), `.well-known/agent-skills/*.md` joins the variant tree, and `fast.mdfromx.com` is a parallel host (`PARALLEL_HOSTS` in `lib/domain-pages.ts`, shared by middleware, `requestOrigin`, and the converter's accepted hosts).
- RFC 9457 problem `type` URIs and `Link: rel=help` stay on x.pcstyle.dev on purpose: they are identifiers, the same error on both hosts.
- `skills/import-x-history/SKILL.md` now names x.pcstyle.dev (variant gives mdfromx.com) and says the key is optional, because that is true on the merged public deployment.

## verified
- audit of the fast branch (agent, spot-checked): fra1 region pin, keyless bulk import (10/15min per IP), single-upstream 429 cooldown, maxDuration 120, MCP/OpenAPI limit drift. The "import double-charges its quota" claim was WRONG: `chargeRequestQuota` only charges the front door and peeks the import counter.
- `accss.json` in ~/x-md-fast holds X session tokens, untracked, hidden only by `.git/info/exclude`; now in `.gitignore`.

## review round 1 (PR #28, CodeRabbit: 12 findings)
- fixed: private-mode bot exemption now covers only the actual embed response (`api/convert.ts`); empty `FXTWITTER_BASE_URL` keeps the public upstream; a backfill skipped by `max_posts` sets `truncated`; `index=true` is in the OpenAPI (`ImportSuccessResponse` = posts | `ImportIndexResponse`).
- declined with reason: all-repost block over `limit` (already decided on #25: over-deliver, never skip; forging a cursor at a repost id is wrong because reposts sort by repost time).
- deferred as follow-ups, not this PR: private-mode discovery contract (card `authentication`, OpenAPI security), profile-work quota (adam's decision), pool cooldown wait, archive repost timeline position, atomic index update, NDJSON cap.

## review round 2 (c746ecf)
- fixed the out-of-diff/minor items (keyed no-store, HEAD before archive read, epoch clamp, upstream-health spread order, admin unavailable state, safe-integer quotas, import analytics format, stale limit/history copy).
- declined: HEAD free of the front-door quota (convert and browse charge HEAD too); benchmark strategy label (record of the run behind bench/RESULTS.md); api/index.ts private-mode auth metadata (same follow-up as the discovery contract).
- state: build/Vercel/Socket green, CodeQL fails on the pre-existing SHA-256 API-key alert (false positive, not a required check), CodeRabbit CHANGES_REQUESTED rests on the declined HEAD item only.

## open (adam decides)
- fast.mdfromx.com: still on the separate `x-md-fast` Vercel project (private mode, own FxEmbed pool, Upstash). Move the domain to `x-md` or retire it.
- whether bulk import may stay keyless on the public service, and whether `regions: ["fra1"]` should apply to the whole project.
- commits are unsigned (no signing key on this VM); main's ruleset requires signed commits.
