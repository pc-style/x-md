# `GET /:handle/posts` latency

Measured 2026-10-14 from the fra1 box with `scripts/bench-posts.ts`, which runs the real `api/import.ts` handler
in-process, base (`origin/main` at 6a29e58) and head back to back with alternating order, against @paulg.
Redis is an in-memory Upstash fake charging 25 ms per round trip and 20 MB/s, calibrated from production (a
small archive read is ~27 ms per hop; one read of the 3,581-post @paulg archive adds ~540 ms).

- **warm**: the archive already holds ~3,000 posts and is older than a minute, so the request tops it up. This is
  the production case behind the 6.1 s baseline (`/paulg/posts?limit=50`).
- **cold**: empty archive, so the request walks the timeline from scratch.

Live runs hit api.fxtwitter.com, whose timeline answers come back short (0–1 items) 25–60% of the time
depending on the hour, and whose profile endpoint answers a spurious NOT_FOUND about a third of the time.
Simulated runs (`--sim`) replace it with that measured behaviour so variants can be compared without its mood
swings. Live runs were paced under 200 upstream requests a minute (`--cap 200`).

## Final (origin/main vs this branch)

Live, 2026-10-14 05:43–06:06 UTC, `bun scripts/bench-posts.ts --base <origin/main checkout> --cap 200` on the
final commit; 10 pairs for warm50, warm200 and cold200, 5 for cold50. Medians over every run, p90 in brackets; a
run that failed outright (503 after the profile endpoint's spurious misses) counts with its time.

| scenario | base | head | speedup (median) | upstream req/run base → head | failed runs base / head | same posts |
|---|---:|---:|---:|---:|---:|---:|
| warm50 | 5.2 s (6.9 s) | 2.2 s (5.6 s) | 2.4× | 2.7 → 5.3 | 0 / 0 | 10/10 |
| warm200 | 3.1 s (5.3 s) | 1.2 s (1.9 s) | 2.6× | 2.4 → 4.0 | 0 / 0 | 10/10 |
| cold50 | 19.7 s (22.1 s) | 3.8 s (5.0 s) | 5.2× | 66 → 35 ¹ | 1 / 0 | 4/4 completed |
| cold200 | 27.8 s (94.1 s) | 8.9 s (14.1 s) | 3.1× | 128 → 89 ¹ | 2 / 0 | 8/8 completed |

¹ Per completed run; a base run that fails on the profile stops after three requests.

Over completed runs only, cold200 is 33.0 s → 8.9 s (3.7×); the other rows do not change.

Recall, scored against the union of every completed run (non-repost posts newer than the newest run's oldest):
warm50, warm200 and cold50 100% for both. In cold200 both sides miss the same post in most runs: @paulg's
2026-10-02 13:39 reply, which X folds under a newer reply in the same conversation and shows only from a page
that starts between the two. Base found it in 1 of 8 completed runs and head in 2 of 10, so recall is 99.4% and
99.5%, and every completed pair returned the same 200 posts. Base flagged `page_missing` in 7 of its 8 completed
cold200 runs and head in none (see below).

Simulated (`--sim`, short 30%, profile miss 30%, 12 pairs per scenario, final commit):

| scenario | base | head | upstream req/run base → head | same posts |
|---|---:|---:|---:|---:|
| warm50 | 4.3 s (6.0 s) | 1.7 s (2.2 s) | 2.5 → 4.2 | 11/11 completed |
| warm200 | 4.7 s (7.0 s) | 2.1 s (3.8 s) | 2.8 → 4.4 | 12/12 |
| cold50 | 20.3 s (26.4 s) | 4.3 s (7.5 s) | 72 → 36 | 12/12 |
| cold200 | 22.1 s (25.0 s) | 8.9 s (11.6 s) | 73 → 77 ² | 9/9 completed |

² The simulated upstream answers short at random rather than in bursts, so main's chains walk out fewer pages
there than live, and head's extra page copies outweigh what the early stop saves.

Production baseline for the headline request, `/paulg/posts?limit=50` (warm): 6.1 s on 2026-10-13; base measured
5.2 s here. A warm request costs one or two upstream pages (hedged) plus the profile (hedged) plus ~0.3 s of
Redis.

## Completeness

X answers the same span differently from cursor to cursor. The case behind every live miss so far: a reply folded
into a later reply's conversation is left out of any page that also holds the later one, and shows only from a
page that starts between the two. What a walk finds therefore depends on exactly where its pages start, so this
branch asks from no start main does not.

- **The walk is main's pool of chains, verbatim.** Every chain claims its next window as soon as it is free, from
  whatever pages are back by then, and every crossing page moves the next window's start, as on main. On top of
  it only two things change: the walk stops once nothing still to be asked could change the newest `max_posts` (a
  page holds only ids below the instant it starts from, and with `max_posts` held main claims no new window), and
  a page that may hold part of the answer goes out as two copies. Main's windows past the first round depend on
  response timing (a chain that finishes first claims the next window from what it has seen), so the grid this
  walk asks equals main's under the same response times; faster hedged pages make it the grid main would ask on
  a faster upstream.
- **Differential test.** `lib/import-grid.test.ts` drives main's walker (snapshotted verbatim in
  `lib/fixtures/import-main.ts`) and this one over 300 random timelines with folded replies, quiet stretches,
  reposts, old thread roots and page misses, four configurations each (concurrency 1 and 16 at random limits, a
  filtered limit 200/500 at 16, a bounded range at 1, 4 or 16), with every answer and its latency a function of
  where the page starts. It checks that this walker asks from no start main does not above main's oldest returned
  post, that any extra start lies below the account's join date (windows cut before the profile has said where
  that is), and that both return the same posts. It also pins the reviewer's case (500 hourly posts, 30 to a page,
  limit 100, the reply at 57 hidden under the one at 55). A one-off run over 2,000 timelines (8,000 pairs) passed
  too; against round 2's walker the test fails at the first seed.
- **Page copies keep main's retry schedule.** Round 3's first live batch lost posts in head runs only: copies of a
  page shared one five-attempt budget and spent it two at a time, inside ~2.5 s, and X keeps failing some cursors
  for a few seconds. One run lost the page from 2026-10-02 13:47 to five NOT_FOUND or empty answers sent within
  2.5 s, resumed from a later position where the 13:39 reply is folded away, and so missed it; main asked from the
  same position once and got 29 posts. Another lost a 50-post stretch without any warning. Main's five attempts go
  out one after another and span ~10 s. The first copy now runs exactly main's loop and the second retries
  alongside it until the first ends, so a page fails only where main's would; in the final batch head flagged no
  `page_missing` in any of its 35 runs, base in 9.

Earlier versions, for the record: round 1 sized windows to one page and decided crossing from a page's bottom
cursor, which asked from a coarser grid and lost such replies (99.3% recall, the same reply every time). Round 2
cut the first round of windows like main but moved the next window's start only after the first page, which
changed every later window, even at concurrency 1.

## What moved the numbers

| change | effect |
|---|---|
| bounded archive reads (2 × 8 MB → ~200 KB) and the read overlapped with the top-up | warm: −0.5 to −1 s of Redis |
| two copies of the first page and of each window page that may hold part of the answer | cuts the short-answer tail of every page on the critical path |
| profile not awaited before the walk; two copies, a third only after two misses | warm: the spurious miss is off the critical path |
| chains cut once the answer is settled | cold: main waits for every chain to walk its window out (cold200 p90 94 s) |
| parallel chunked archive writes | a write is one round of pipelined chunks instead of one round per 150 posts |

Given up for exactness: handing windows out only as the answer needs them (round 2: cold50 15 requests, cold200
50). Main cuts its later windows from whatever pages have returned when a chain frees, so launching windows later
than main does changes where those windows start; with every window main launches going out when main launches
it, a cold walk costs 35–90 requests against main's 66–128.

Rejected along the way (simulated): a third copy of the first page (−5% median, +50% requests); a profile that
sends its second copy only after 1.6 s (warm50 3.1 s against 2.1 s with two copies up front).
