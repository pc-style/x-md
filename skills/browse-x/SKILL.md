---
name: browse-x
description: Read public X posts, threads, profiles, and search results. Use for X/Twitter links or research.
allowed-tools:
  - Bash(bun scripts/browse-x.ts *)
  - Bash(curl *x.pcstyle.dev*)
---

# browse x

public content through x.pcstyle.dev. no X login needed. run the helper from this skill's directory:

## when to use this

reach for it whenever the job is reading one piece of public X content right now:

- you need the text of a public X post, thread, or X Article and can't run a browser or log into X.
- you hit an `x.com`, `twitter.com`, or `t.co` link in a document, issue, changelog, or chat log and need its content inline.
- you want a public profile's bio and latest original posts (replies and reposts filtered out).
- you're checking who a public account follows, or who follows it.
- you want X search results as data rather than a rendered timeline.
- you're saving a post into notes or a vault — `--format obsidian` emits YAML frontmatter.

## when not to use this

- anything that writes. it never posts, replies, follows, likes, bookmarks, or sends DMs, and takes no X credentials.
- private, protected, suspended, or deleted accounts and posts. never available; no flag unlocks them.
- X Lists, DMs, notifications, the personalized home timeline, account analytics. not supported.
- bulk collection, backfills, or dataset building. it's rate limited and cached for one question at a time.
- anything needing guaranteed completeness or an SLA. results come from public upstream providers and can lag or truncate — read `warnings` instead of assuming.

```bash
bun scripts/browse-x.ts "https://x.com/handle/status/123"
bun scripts/browse-x.ts profile handle
bun scripts/browse-x.ts search "from:handle release"
bun scripts/browse-x.ts followers handle
bun scripts/browse-x.ts following handle
```

## options

markdown by default. `--json` for structured output, `--full` for metadata, `--compact` for less. use `--cursor` with the returned cursor to continue. run `bun scripts/browse-x.ts --help` for thread, feed, and other options.

optional: `X_MD_API_KEY` sends a bearer key; `X_API_BASE` changes the host. never print the key. invalid or disabled keys return 401.

## limits

public and keyed requests have different quotas. on 429 (exit 3), wait for the printed `Retry-After`; don't loop retries. exit 2 means bad arguments, exit 1 means another error. private or deleted content may be unavailable. check `warnings`; don't invent missing replies, media, or pinned posts.
