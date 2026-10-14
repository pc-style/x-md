# Browse latency: `/search`, `/:handle/followers`, `/:handle/following`

Run 2026-10-13 with `bun bench/browse-latency.ts` (see the header of that file). The benchmark drives the real
`api/browse.ts` handler with the network replaced by in-process stand-ins: a store that speaks the REST pipeline
protocol, an FxTwitter base, and the own-account search endpoint, each with a configurable latency. Every store
request is counted, so the structural numbers (requests, sequential hops) are exact whatever the simulated latency.

## Where production spends its time (curl from fra1, same day)

| probe | TTFB |
|---|---:|
| `OPTIONS /search` (function invoked, no store work) | 70–90 ms |
| `GET /search?q=…` app-cache hit, CDN miss | 104 ms |
| `GET /search?q=<unseen>` miss, own-account provider, 0 results | 746 ms |
| `GET /jack/followers` miss | 2,706 ms |
| `GET /jack/followers` app-cache hit, CDN miss | 144 ms |
| FxTwitter followers page, fetched directly (3 samples) | 604 ms, 3,537 ms, 2,378 ms (404) |
| X API network floor from this box (unauthenticated, 4xx) | 160–190 ms |

A hit pays the invocation floor plus two store hops, which puts one store hop at roughly 10–15 ms. A miss is
dominated by the provider call: an own-account search is a few hundred milliseconds and an FxTwitter list page
anywhere from half a second to several seconds. The part of a miss that x.md's own code controls is the chain of
store round trips around the provider call, and that is what changed.

## Before and after, production-like latencies

`--runs 40 --redis-ms 12 --x-ms 450 --fx-ms 600 --fx-slow-ms 2800`, both runs on 2026-10-14 back to back: the
"before" from a detached checkout of `main` at 3c1c8dd (which carries the cold-start, cold-status and browse
pagination work, including the single-flight cache fills of #69), the "after" from this branch merged onto it
(9b942fe). "Own overhead" is the median minus the simulated provider latency, i.e. the time spent in x.md's own
request path. Store hops are sequential round trips on the critical path (measured separately with
`--runs 10 --redis-ms 100 --x-ms 0 --fx-ms 0 --fx-slow-ms 0`, where each hop shows up as ~100 ms).

| scenario | median before | median after | p90 before | p90 after | own overhead before → after | store hops before → after |
|---|---:|---:|---:|---:|---:|---:|
| search miss, own-account provider, cold instance | 604.8 ms | 529.7 ms | 609.2 ms | 534.0 ms | 154.8 → 79.7 ms (1.9×) | 12 → 6 |
| search miss, own-account provider, warm instance | 542.2 ms | 517.0 ms | 550.3 ms | 521.0 ms | 92.2 → 67.0 ms (1.4×) | 7 → 5 |
| search miss, FxTwitter up, cold instance | 666.6 ms | 629.2 ms | 670.8 ms | 631.1 ms | 66.6 → 29.2 ms (2.3×) | 5 → 2 |
| search hit, shared cache, cold instance | 25.1 ms | 12.9 ms | 26.3 ms | 13.9 ms | 25.1 → 12.9 ms (1.9×) | 2 → 1 |
| followers miss, one upstream page, cold instance | 640.1 ms | 616.0 ms | 644.5 ms | 618.9 ms | 40.1 → 16.0 ms (2.5×) | 3 → 1 |
| followers miss, slow upstream (3 of 5 pages slow), two bases | 2,839.0 ms | 1,416.2 ms | 2,842.7 ms | 2,817.6 ms | n/a (upstream-bound) | 3 → 1 |
| following hit, shared cache, cold instance | 25.0 ms | 12.7 ms | 26.4 ms | 14.2 ms | 25.0 → 12.7 ms (2.0×) | 2 → 1 |

The same seven scenarios were first measured against `main` at f9e9e78 on 2026-10-13; the numbers moved by well
under a millisecond when the baseline was taken again at 3c1c8dd, because #69's single-flight only takes effect
when several requests for one key overlap, which this benchmark never does.

"Cold instance" resets the per-instance memos (breaker state, pool snapshot, in-process cache) before every
request, which is the common case for a lightly used serverless function. "Warm" keeps them. The slow-upstream
scenario spends 1.7 upstream requests per list on average: the hedge fires only on pages still unanswered after
800 ms, and its p90 is unchanged because when both copies land on slow pages nothing can help.

## What changed

- The handler starts the cache lookup while the front-door quota charge is in flight. `browse` takes the charge's
  verdict as an `admission` promise and hands it to `withCache`, which runs the lookup at once but will not serve a
  hit, start the origin, or join another caller's fill until the verdict allows; a denial is answered by the
  handler's own 429 exactly as before. The per-caller flight key and the single-flight fills from #69 are intact:
  a fill still starts only after admission, so no caller's pending quota failure is ever shared.
- The shared cache write after a miss is handed to `waitUntil` (`withCache`'s `defer` hook) instead of being
  awaited before the response; the in-process copy is published first, as before, so concurrent callers read it.
- The FxTwitter search breaker is read alongside the live-search burst gate instead of after it.
- For the own-account provider, the pool split takes two store hops instead of four: settings and key index
  together, then key records and every counter together. It is still read after the per-IP charge, so key usage
  that lands during that charge shrinks the public cap. A follow-up to #70 restored that order after #70 overlapped them,
  which costs back one store hop on an own-account search miss (the 12 → 6 row above becomes 12 → 7).
- A followers/following page still unanswered after 800 ms is asked of another base in the FxTwitter pool as
  well, and the first good answer wins. The hedge always goes to a base other than the one already in flight, and
  does not fire when every other base is cooling down. A single-base deployment (the default) is never asked
  twice, so this only takes effect once `FXTWITTER_BASE_URL` names two or more bases.

Charges happen in the same order with the same keys; only reads were moved alongside them. End-to-end, a miss is
still bound by the provider call, so the medians above move by the saved store hops, not by multiples; the hedge is
the one change that moves a provider-bound median, and only on a pooled deployment.
