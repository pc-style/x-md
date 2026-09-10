# Import throughput benchmark

Run 2026-09-09T19:17:23.256Z against `https://api.fxtwitter.com` from one IP, paced under 840 req/min. Target ≈ 600 posts per account, replies and reposts included. Completeness is measured against the union of every run for that account (non-repost posts only: reposts at range edges are ambiguous by nature).

## @elonmusk

Range 2026-09-04T05:35 → 2026-09-09T19:17, est. 4.49 posts/h, reference 166 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential (naive) | 250 | 104 | 85 | 14.1 s | **18** | 13 | 5 | 0 | 0 | 99.4% |
| sequential + short-page retry | 250 | 104 | 85 | 16.2 s | **15** | 13 | 5 | 0 | 0 | 99.4% |
| parallel c=4 | 248 | 103 | 84 | 7.5 s | **33** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=8 | 248 | 103 | 84 | 6.0 s | **41** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=16 (default) | 248 | 103 | 84 | 4.4 s | **56** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=24 | 248 | 103 | 84 | 5.9 s | **42** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=32 | 248 | 103 | 84 | 4.1 s | **60** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=16 window=30 | 252 | 104 | 87 | 4.5 s | **56** | 29 | 12 | 0 | 0 | 99.4% |
| parallel c=16 window=120 | 251 | 103 | 87 | 7.2 s | **35** | 19 | 8 | 0 | 0 | 98.8% |
| parallel c=16 window=240 | 251 | 103 | 87 | 8.9 s | **28** | 16 | 6 | 0 | 0 | 98.8% |
| parallel c=16 no retry | 248 | 103 | 84 | 5.1 s | **49** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=16 originals only | 148 | 0 | 89 | 7.9 s | **19** | 12 | 8 | 0 | 0 | 100.0% |
| sequential (naive) | 250 | 104 | 85 | 14.6 s | **17** | 13 | 5 | 0 | 0 | 99.4% |
| sequential + short-page retry | 250 | 104 | 85 | 18.0 s | **14** | 13 | 5 | 0 | 0 | 99.4% |
| parallel c=4 | 248 | 103 | 84 | 7.9 s | **31** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=8 | 248 | 103 | 84 | 5.1 s | **49** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=16 (default) | 248 | 103 | 84 | 4.8 s | **52** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=24 | 248 | 103 | 84 | 4.6 s | **53** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=32 | 248 | 103 | 84 | 6.1 s | **41** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=16 window=30 | 252 | 104 | 87 | 5.2 s | **48** | 29 | 12 | 0 | 0 | 99.4% |
| parallel c=16 window=120 | 251 | 103 | 87 | 7.4 s | **34** | 19 | 8 | 0 | 0 | 98.8% |
| parallel c=16 window=240 | 251 | 103 | 87 | 7.9 s | **32** | 16 | 6 | 0 | 0 | 98.8% |
| parallel c=16 no retry | 248 | 103 | 84 | 6.6 s | **38** | 21 | 8 | 0 | 0 | 98.8% |
| parallel c=16 originals only | 148 | 0 | 89 | 6.8 s | **22** | 12 | 8 | 0 | 0 | 100.0% |

## @levelsio

Range 2026-09-05T20:04 → 2026-09-09T19:20, est. 6.30 posts/h, reference 110 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential (naive) | 114 | 70 | 5 | 8.1 s | **14** | 7 | 6 | 0 | 0 | 99.1% |
| sequential + short-page retry | 114 | 70 | 5 | 9.2 s | **12** | 7 | 6 | 0 | 0 | 99.1% |
| parallel c=4 | 114 | 70 | 5 | 5.0 s | **23** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=8 | 114 | 70 | 5 | 4.6 s | **25** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=16 (default) | 114 | 70 | 5 | 4.5 s | **25** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=24 | 114 | 70 | 5 | 5.6 s | **20** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=32 | 114 | 70 | 5 | 4.6 s | **25** | 17 | 15 | 1 | 0 | 99.1% |
| parallel c=16 window=30 | 115 | 71 | 5 | 3.4 s | **33** | 24 | 21 | 0 | 0 | 100.0% |
| parallel c=16 window=120 | 114 | 70 | 5 | 4.2 s | **27** | 11 | 10 | 0 | 0 | 99.1% |
| parallel c=16 window=240 | 114 | 70 | 5 | 6.1 s | **19** | 10 | 9 | 0 | 0 | 99.1% |
| parallel c=16 no retry | 114 | 70 | 5 | 6.3 s | **18** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=16 originals only | 30 | 0 | 5 | 3.4 s | **9** | 5 | 17 | 0 | 0 | 100.0% |
| sequential (naive) | 114 | 70 | 5 | 9.0 s | **13** | 7 | 6 | 0 | 0 | 99.1% |
| sequential + short-page retry | 114 | 70 | 5 | 9.2 s | **12** | 7 | 6 | 0 | 0 | 99.1% |
| parallel c=4 | 114 | 70 | 5 | 9.4 s | **12** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=8 | 114 | 70 | 5 | 5.2 s | **22** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=16 (default) | 114 | 70 | 5 | 3.9 s | **30** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=24 | 114 | 70 | 5 | 5.5 s | **21** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=32 | 114 | 70 | 5 | 3.7 s | **31** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=16 window=30 | 115 | 71 | 5 | 3.6 s | **32** | 24 | 21 | 0 | 0 | 100.0% |
| parallel c=16 window=120 | 114 | 70 | 5 | 3.7 s | **31** | 11 | 10 | 0 | 0 | 99.1% |
| parallel c=16 window=240 | 114 | 70 | 5 | 6.9 s | **17** | 10 | 9 | 0 | 0 | 99.1% |
| parallel c=16 no retry | 114 | 70 | 5 | 4.4 s | **26** | 16 | 14 | 0 | 0 | 99.1% |
| parallel c=16 originals only | 30 | 0 | 5 | 3.8 s | **8** | 5 | 17 | 0 | 0 | 100.0% |

## @paulg

Range 2026-08-16T01:28 → 2026-09-09T19:22, est. 1.01 posts/h, reference 323 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential (naive) | 235 | 127 | 67 | 18.1 s | **13** | 13 | 6 | 0 | 0 | 52.0% |
| sequential + short-page retry | 459 | 239 | 137 | 28.6 s | **16** | 28 | 6 | 4 | 0 | 99.7% |
| parallel c=4 | 459 | 239 | 137 | 11.2 s | **41** | 36 | 8 | 4 | 0 | 99.7% |
| parallel c=8 | 436 | 230 | 125 | 8.6 s | **51** | 37 | 8 | 6 | 0 | 96.3% |
| parallel c=16 (default) | 437 | 231 | 126 | 6.8 s | **64** | 39 | 9 | 8 | 0 | 96.3% |
| parallel c=24 | 459 | 239 | 137 | 7.7 s | **59** | 36 | 8 | 4 | 0 | 99.7% |
| parallel c=32 | 459 | 239 | 137 | 6.2 s | **74** | 37 | 8 | 5 | 0 | 99.7% |
| parallel c=16 window=30 | 459 | 239 | 137 | 5.4 s | **84** | 44 | 10 | 6 | 0 | 99.7% |
| parallel c=16 window=120 | 459 | 239 | 137 | 11.7 s | **39** | 34 | 7 | 4 | 0 | 99.7% |
| parallel c=16 window=240 | 459 | 239 | 137 | 15.6 s | **29** | 31 | 7 | 4 | 0 | 99.7% |
| parallel c=16 no retry | 282 | 141 | 85 | 5.9 s | **48** | 24 | 9 | 0 | 0 | 61.0% |
| parallel c=16 originals only | 217 | 0 | 137 | 5.2 s | **42** | 17 | 8 | 0 | 0 | 100.0% |
| sequential (naive) | 62 | 30 | 20 | 3.6 s | **17** | 4 | 6 | 0 | 0 | 13.0% |
| sequential + short-page retry | 459 | 239 | 137 | 28.1 s | **16** | 26 | 6 | 2 | 0 | 99.7% |
| parallel c=4 | 459 | 239 | 137 | 10.3 s | **45** | 33 | 7 | 1 | 0 | 99.7% |
| parallel c=8 | 459 | 239 | 137 | 7.2 s | **64** | 38 | 8 | 6 | 0 | 99.7% |
| parallel c=16 (default) | 459 | 239 | 137 | 5.9 s | **77** | 39 | 8 | 7 | 0 | 99.7% |
| parallel c=24 | 459 | 239 | 137 | 8.1 s | **57** | 39 | 8 | 7 | 0 | 99.7% |
| parallel c=32 | 459 | 239 | 137 | 6.4 s | **71** | 37 | 8 | 5 | 0 | 99.7% |
| parallel c=16 window=30 | 459 | 239 | 137 | 7.5 s | **61** | 46 | 10 | 8 | 0 | 99.7% |
| parallel c=16 window=120 | 459 | 239 | 137 | 9.3 s | **50** | 39 | 8 | 9 | 0 | 99.7% |
| parallel c=16 window=240 | 459 | 239 | 137 | 13.7 s | **33** | 30 | 7 | 3 | 0 | 99.7% |
| parallel c=16 no retry | 382 | 197 | 113 | 7.7 s | **50** | 27 | 7 | 0 | 0 | 83.3% |
| parallel c=16 originals only | 217 | 0 | 137 | 4.5 s | **49** | 17 | 8 | 0 | 0 | 100.0% |

## @ID_AA_Carmack

Range 2025-08-05T19:26 → 2026-09-09T19:26, est. 0.04 posts/h, reference 326 posts.

| strategy | posts | replies | reposts | wall | posts/s | upstream req | req/100 posts | retries | 429 | completeness |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| sequential (naive) | 345 | 183 | 21 | 19.7 s | **18** | 19 | 6 | 0 | 0 | 99.4% |
| sequential + short-page retry | 345 | 183 | 21 | 19.9 s | **17** | 20 | 6 | 1 | 0 | 99.4% |
| parallel c=4 | 345 | 183 | 21 | 8.9 s | **39** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=8 | 345 | 183 | 21 | 5.6 s | **62** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 (default) | 345 | 183 | 21 | 4.9 s | **70** | 30 | 9 | 1 | 0 | 99.4% |
| parallel c=24 | 345 | 183 | 21 | 5.8 s | **60** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=32 | 345 | 183 | 21 | 5.0 s | **70** | 30 | 9 | 1 | 0 | 99.4% |
| parallel c=16 window=30 | 345 | 183 | 21 | 4.8 s | **73** | 30 | 9 | 1 | 0 | 99.4% |
| parallel c=16 window=120 | 345 | 183 | 21 | 4.6 s | **74** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 window=240 | 345 | 183 | 21 | 4.7 s | **74** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 no retry | 316 | 169 | 21 | 4.8 s | **66** | 27 | 9 | 0 | 0 | 90.5% |
| parallel c=16 originals only | 159 | 0 | 21 | 2.6 s | **61** | 17 | 11 | 0 | 0 | 100.0% |
| sequential (naive) | 345 | 183 | 21 | 20.3 s | **17** | 19 | 6 | 0 | 0 | 99.4% |
| sequential + short-page retry | 345 | 183 | 21 | 24.3 s | **14** | 19 | 6 | 0 | 0 | 99.4% |
| parallel c=4 | 345 | 183 | 21 | 9.1 s | **38** | 30 | 9 | 1 | 0 | 99.4% |
| parallel c=8 | 346 | 184 | 21 | 5.8 s | **60** | 29 | 8 | 0 | 0 | 99.7% |
| parallel c=16 (default) | 345 | 183 | 21 | 4.9 s | **71** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=24 | 345 | 183 | 21 | 4.7 s | **74** | 30 | 9 | 1 | 0 | 99.4% |
| parallel c=32 | 345 | 183 | 21 | 4.8 s | **72** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 window=30 | 345 | 183 | 21 | 4.2 s | **81** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 window=120 | 345 | 183 | 21 | 5.7 s | **61** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 window=240 | 345 | 183 | 21 | 5.2 s | **66** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 no retry | 345 | 183 | 21 | 3.5 s | **98** | 29 | 8 | 0 | 0 | 99.4% |
| parallel c=16 originals only | 159 | 0 | 21 | 2.7 s | **60** | 17 | 11 | 0 | 0 | 100.0% |

## Best performing

| strategy (mean over accounts) | posts/s | completeness | req/100 posts | 429s |
|---|---:|---:|---:|---:|
| parallel c=16 window=30 | **59** | 99.6% | 13 | 0 |
| parallel c=16 (default) | **56** | 98.8% | 10 | 0 |
| parallel c=32 | **56** | 99.2% | 10 | 0 |
| parallel c=16 no retry | **49** | 91.2% | 10 | 0 |
| parallel c=24 | **48** | 99.2% | 10 | 0 |
| parallel c=8 | **47** | 98.9% | 10 | 0 |
| parallel c=16 window=120 | **44** | 99.2% | 8 | 0 |
| parallel c=16 window=240 | **37** | 99.2% | 8 | 0 |
| parallel c=4 | **33** | 99.2% | 10 | 0 |
| sequential (naive) | **16** | 82.6% | 6 | 0 |
| sequential + short-page retry | **15** | 99.4% | 6 | 0 |

**Winner (fastest with ≥99% completeness and no throttling): parallel c=16 window=30 — 59 posts/s, 3.9× the sequential baseline (15 posts/s).**

Total upstream requests: 2168; paced waits: 0 s; wall: 755 s.
