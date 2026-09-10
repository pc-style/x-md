# Import throughput benchmark

Run 2026-09-09T19:30:47.788Z against `https://api.fxtwitter.com` from one IP, paced under 840 req/min. Target ≈ 2000 posts per account, replies and reposts included. Completeness is measured against the union of every run for that account (non-repost posts only: reposts at range edges are ambiguous by nature).

## @paulg

Range 2026-06-19T07:49 → 2026-09-09T19:30, est. 1.01 posts/h, reference 1021 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential + short-page retry | 1375 | 712 | 363 | 79.2 s | **17** | 81 | 6 | 10 | 0 | 99.1% |
| parallel c=16 (default) | 1379 | 716 | 363 | 11.3 s | **122** | 138 | 10 | 22 | 0 | 99.5% |
| parallel c=32 | 1379 | 716 | 363 | 7.8 s | **176** | 130 | 9 | 14 | 0 | 99.5% |

## @levelsio

Range 2026-08-23T03:03 → 2026-09-09T19:32, est. 4.71 posts/h, reference 885 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential + short-page retry | 906 | 455 | 26 | 55.6 s | **16** | 50 | 6 | 3 | 0 | 99.4% |
| parallel c=16 (default) | 907 | 455 | 27 | 12.1 s | **75** | 96 | 11 | 1 | 0 | 99.4% |
| parallel c=32 | 903 | 455 | 27 | 8.7 s | **104** | 97 | 11 | 2 | 0 | 99.0% |

## Best performing

| strategy (mean over accounts) | posts/s | completeness | req/100 posts | 429s |
|---|---:|---:|---:|---:|
| parallel c=32 | **140** | 99.2% | 10 | 0 |
| parallel c=16 (default) | **99** | 99.5% | 11 | 0 |
| sequential + short-page retry | **17** | 99.3% | 6 | 0 |

**Winner (fastest with ≥99% completeness and no throttling): parallel c=32 — 140 posts/s, 8.2× the sequential baseline (17 posts/s).**

Total upstream requests: 594; paced waits: 0 s; wall: 177 s.
