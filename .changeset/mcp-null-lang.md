---
"mdfromx": patch
---

fixed the MCP `x_md_get_post` and `x_md_get_profile` output schemas rejecting a post whose `lang` is null, which is what FxTwitter sends when it cannot tag a post with a language. A client that validates structured output against the published schema rejected the whole call, even though the rendered Markdown was correct. The HTTP contract has always allowed the null.
