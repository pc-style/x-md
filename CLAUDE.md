# x-md

Read [`AGENTS.md`](AGENTS.md) first — it holds the conventions for this repo (build order, design tokens,
landing copy frame, the error module, versioned routes, quotas, discovery documents, and the checks to run
before pushing). This file only adds what is specific to working here with Claude Code.

- **Open work lives in [`TODO.md`](TODO.md).** Read it at the start of a session. Right now it tracks the
  agent-readiness push (getting x.pcstyle.dev to 100/100 on is-agentic): what is already on the branch, what
  needs a human, and what was deliberately left undone with the reasoning. Update it when you finish or
  change one of those items rather than letting it rot.
- Checks before pushing: `bun run test` and `bun run build` (the build starts with `tsc`, so a separate run is
  redundant). After touching `lib/openapi.ts`, run `bun run openapi:build` and **commit** the regenerated
  `public/openapi.json` — `bun run build` rewrites that file in place, so `openapi:check` can never fail
  straight after a build; it is the CI guard against a stale committed copy.
- `main` takes a PR. Its ruleset requires the `build` and `CodeRabbit` checks, a deployment to the `Preview`
  environment, **signed commits**, and the branch up to date with `main`. No approvals are required, and
  merges must be squash or merge — rebase is disabled. An unsigned commit blocks the merge no matter how
  green everything else is. Repo admins hold an always-on bypass; other contributors do not.
- The `CodeQL` check is red on the open PR and that is expected: three alerts are knowingly open, one of them
  pre-existing and flagged critical. CodeQL is not a required check. Read TODO.md before "fixing" any of them —
  the two that are ours are false positives, and the obvious fixes would corrupt JSON bodies or clobber the
  `problem+json` content type.
