# Changelog

Notable changes are documented here. x.md has not published a tagged release yet.

## Unreleased

- Fix the `users` search feed returning `@unknown` entries: patch `@the-convocation/twitter-scraper` so people-search results read `name`, `screen_name`, avatar, and join date from X's newer `core`/`avatar` fields when `legacy` omits them.
- Mark the API beta and document provider, cache, privacy, and provenance boundaries.
- Add immutable self-hosting guidance, compatibility notes, and a security policy.
- Run the Vite, Vitest, and TypeScript CLIs through Bun for consistent local and CI execution.
