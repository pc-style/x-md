# Fast X Circle

A faster X interaction circle for any public account. It uses the [x.md bulk import](https://mdfromx.com/docs/bulk-import) for the account’s own posts and x.md search for incoming mentions, then draws the same rings, scores, and PNG as [X Circle](https://cut-noodle.com/x-circle).

The API key is read from `X_MD_API_KEY` on the server. It is not part of the page, the client bundle, or the benchmark files.

```bash
bun run build
bun run start
```

Open http://127.0.0.1:8787. The benchmark and the notes on how the circle is scored are linked from the header.
