# mdfromx

## 0.1.2

### Patch Changes

- 4511491: Post reads (`posts.get` and `posts.markdown`, in the plain and Effect clients) now fail with `401 invalid_key` when the client is configured with an API key the service does not recognise or has disabled. Previously the service ignored the bad key and answered anonymously. To recover, correct the configured key, or omit it to call the public API anonymously.

## 0.1.1

### Patch Changes

- 3563511: fixed the MCP `x_md_get_post` and `x_md_get_profile` output schemas rejecting a post whose `lang` is null, which is what FxTwitter sends when it cannot tag a post with a language. A client that validates structured output against the published schema rejected the whole call, even though the rendered Markdown was correct. The HTTP contract has always allowed the null.
- 805d9e1: Built against the API's OpenAPI 1.2.0 document, with no type changes: a missing account is now a 404 `not_found` instead of a retryable 503, `RateLimit` headers count the current search, and a 429 suggests requesting an API key for sustained use.
