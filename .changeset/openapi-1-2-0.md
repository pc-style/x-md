---
"mdfromx": patch
---

Built against the API's OpenAPI 1.2.0 document, with no type changes: a missing account is now a 404 `not_found` instead of a retryable 503, `RateLimit` headers count the current search, and a 429 suggests requesting an API key for sustained use. `effect` is now required at `^4.0.6`.
