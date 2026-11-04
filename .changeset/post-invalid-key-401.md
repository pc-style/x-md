---
"mdfromx": patch
---

Post reads (`posts.get` and `posts.markdown`, in the plain and Effect clients) now fail with `401 invalid_key` when the client is configured with an API key the service does not recognise or has disabled. Previously the service ignored the bad key and answered anonymously. To recover, correct the configured key, or omit it to call the public API anonymously.
