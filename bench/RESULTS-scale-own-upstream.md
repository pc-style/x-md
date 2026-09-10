# Import throughput benchmark

Run 2026-09-09T23:52:46.451Z against `https://xmd-fx.pcstyle.workers.dev,https://api.fxtwitter.com` from one IP, paced under 840 req/min. Target ≈ 2000 posts per account, replies and reposts included. Completeness is measured against the union of every run for that account (non-repost posts only: reposts at range edges are ambiguous by nature).

## @paulg

Range 2026-06-23T10:27 → 2026-09-09T23:52, est. 1.06 posts/h, reference 983 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential + short-page retry | 98 | 47 | 32 | 8.6 s | **11** | 12 | 12 | 6 | 0 | 6.7% |
| parallel c=16 (default) | 1332 | 693 | 349 | 13.9 s | **96** | 139 | 10 | 27 | 0 | 100.0% |
| parallel c=32 | 1332 | 693 | 349 | 7.4 s | **180** | 142 | 11 | 30 | 0 | 100.0% |

## Best performing

| strategy (mean over accounts) | posts/s | completeness | req/100 posts | 429s |
|---|---:|---:|---:|---:|
| parallel c=32 | **180** | 100.0% | 11 | 0 |
| parallel c=16 (default) | **96** | 100.0% | 10 | 0 |
| sequential + short-page retry | **11** | 6.7% | 12 | 0 |

**Winner (fastest with ≥99% completeness and no throttling): parallel c=32 — 180 posts/s, 16.4× the sequential baseline (11 posts/s).**

Total upstream requests: 294; paced waits: 0 s; wall: 31 s.
