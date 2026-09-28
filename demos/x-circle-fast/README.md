# X Circle, fast

A faster version of [X Circle](https://cut-noodle.com/x-circle) built on the [x.md API](https://mdfromx.com/docs/bulk-import). Type any public X username and it draws the people that account interacts with most, closest in the middle. It uses the same look, ranking, and ring layout as the original, and exports a 1200×1200 PNG.

Benchmark against the original: [`bench/RESULTS.md`](bench/RESULTS.md) (also served at `/bench/`). On three accounts x.md had never archived (@rsms, @tobi, @shl), the demo put a usable circle on screen in 1.2–1.6 s against the original's 14.0–14.3 s, finished in 9.9–11.5 s against 14.1–14.5 s, and read 1.6–2.1× as many posts. The original shows its first count sooner (0.7–1.1 s against 1.2–1.6 s): the demo waits for x.md's first page of a never-archived account. [`bench/results/race.mp4`](bench/results/race.mp4) is a side-by-side recording of both on a fourth fresh account.

## Run it

```bash
cd demos/x-circle-fast
bun install
X_MD_API_KEY=… bun server.ts        # http://localhost:8787
```

The key is read from the environment on the server and never reaches the browser. The only server env vars are `X_MD_API_KEY` (required), `X_MD_BASE` (default `https://mdfromx.com`), `PORT` (default `8787`), and `CIRCLES_PER_IP` (default 12 per 15 minutes, so a public URL cannot drain the key).

## Why it is faster

The original reads FxTwitter from the browser one cursor page at a time: up to 10 sequential pages of the account's own posts, 10 sequential pages of `@handle` search (or, when search is down, up to 80 reply threads six at a time), and then 4 profile lookups at a time for missing photos. It shows nothing until all of that is done.

This demo changes where and how the reading happens:

| | Original | Fast demo |
| --- | --- | --- |
| Own posts and replies | 10 sequential cursor pages from the browser | one x.md bulk import (`/api/v1/profiles/{h}/posts?format=ndjson`) that x.md walks with 16 parallel chains and streams back; closed as soon as the 1000-post cap is reached |
| Mentions by others | 10 sequential search pages | x.md search (`@h -from:h`, 20 posts a page): one page, then the time before it is split into up to 7 windows of the same span, all read at once |
| When search is unavailable | up to 80 reply threads, 6 at a time, after the posts finish | up to 40 reply threads, all at once, starting while the posts are still streaming |
| Missing photos | 4 at a time, after ranking | fetched in bulk (25 at a time server-side) for the current top 70 while posts stream |
| First picture | after everything | as soon as the first interactions land; it redraws while data arrives |

Raw posts never reach the browser. `src/harvest.ts` turns them into interaction records on the server and appends them, in ~80 ms batches, to a per-circle event log (`src/jobs.ts`). The browser long-polls that log and ranks and redraws on each batch. A long poll rather than a streamed response because proxies such as a Cloudflare quick tunnel hold a streamed body until it ends, which hid every early batch (the first benchmark run, kept in `bench/results/run1-stream-buffered-by-tunnel/`, shows it).

## Scoring (same as X Circle)

- An interaction counts by type: reply 3, quote 2.5, mention 1.5, repost 1.
- Each interaction's value halves every 30 days.
- Per person, what the account gave (`a`) and what it got back (`b`) combine as `(√a + √b)²`. One-way contact stays the plain sum; an even two-way exchange doubles.
- The reply chain X puts at the start of every answer does not count as a mention. When a search result has no mention facets, the chain is read from the leading `@handles` in the text.
- Up to 50 people. Unticking someone in the list takes them out of the picture.

## Files

- `server.ts`: Bun server. `POST /api/circle?handle=` starts a circle and returns its id; `GET /api/circle/{id}?after=N` long-polls its events; `POST /api/circle/{id}/profiles?handles=` asks for names and photos, which arrive on the same log; `/bench/` and `/source/` are read-only folders.
- `src/jobs.ts`: the per-circle event log the browser long-polls.
- `src/core.ts`: interaction extraction and ranking, shared by server and browser. Tests are in `src/core.test.ts`, which the repo's `bun run test` runs.
- `src/harvest.ts`: the x.md calls. It paces its search windows from the key's `RateLimit` header.
- `src/draw.ts`: the ring layout and canvas renderer, ported from the original so the PNG matches.
- `src/client.ts`, `public/`: the page.
- `bench/run.ts`: headless-Chrome benchmark of both sites. `bench/fresh.ts` picks accounts x.md has never archived. `bench/report.ts` renders the results. `bench/race.ts` records both sites side by side on one account.

## Limits

- Depth follows the original's: posts from the last 120 days, up to 1000 of the account's own posts, and up to 8 search pages (160 posts) of mentions per circle, against the original's 10. For a much-mentioned account those pages reach back days rather than the full 120. Reading the reply threads of the older posts as well was tried and dropped: on @hillelogram it added 11 mentions and 4 s.
- Mentions depend on the key's search allowance. When it runs out, incoming replies come from the reply threads under the account's own posts (as the original does when its search is down), and the page says so.
