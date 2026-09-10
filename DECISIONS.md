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

## open (adam decides)
- fast.mdfromx.com: still on the separate `x-md-fast` Vercel project (private mode, own FxEmbed pool, Upstash). Move the domain to `x-md` or retire it.
- whether bulk import may stay keyless on the public service, and whether `regions: ["fra1"]` should apply to the whole project.
- commits are unsigned (no signing key on this VM); main's ruleset requires signed commits.
