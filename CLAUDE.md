# x-md

Read [`AGENTS.md`](AGENTS.md) first — it holds the conventions for this repo (build order, design tokens,
landing copy frame, the error module, versioned routes, quotas, discovery documents, and the checks to run
before pushing). This file only adds what is specific to working here with Claude Code.

- Checks before pushing: `bun run test` and `bun run build` (the build starts with `tsc`, so a separate run is
  redundant). After touching `lib/openapi.ts`, run `bun run openapi:build` and **commit** the regenerated
  `public/openapi.json` — `bun run build` rewrites that file in place, so `openapi:check` can never fail
  straight after a build; it is the CI guard against a stale committed copy.
- `main` takes a PR. Its ruleset requires the `build` and `CodeRabbit` checks, a deployment to the `Preview`
  environment, **signed commits**, and the branch up to date with `main`. No approvals are required, and
  merges must be squash or merge — rebase is disabled. An unsigned commit blocks the merge no matter how
  green everything else is. Repo admins hold an always-on bypass; other contributors do not.
- Two CodeQL alerts are dismissed as false positives, with the reasoning on the alerts themselves:
  `js/xss-through-exception` in `lib/apierror.ts` and `js/reflected-xss` in `api/oembed.ts`. Both responses set
  an explicit JSON content type via `setHeader` and the site sends `nosniff` globally; CodeQL flags
  `res.send(string)` because Express infers `text/html` when no type is set. Do not "fix" them — HTML-escaping
  inside a JSON body corrupts legitimate text, and `res.json()` would clobber the `problem+json` type the RFC
  9457 error handling depends on.
- Scoring work is measured against the scorer's own data, not guesswork: `https://ora.ai/api/checks` lists all
  125 checks with their criteria and weights, and `https://ora.ai/api/score/x.pcstyle.dev` gives the per-check
  result with the exact evidence string. `npx is-agentic x.pcstyle.dev` reads the latest *stored* report and
  cannot force a re-scan — trigger one at <https://is-agentic.com/scan/x.pcstyle.dev>.
