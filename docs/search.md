---
title: Search X
description: Find posts and people with the same five feeds as X search.
sidebar:
  order: 2
---

## Search for posts

`GET /search?q={query}`

```bash
curl -sS -G 'https://x.pcstyle.dev/search' \
  --data-urlencode 'q=from:vercel release' \
  --data-urlencode 'feed=latest' \
  --data-urlencode 'limit=20'
```

Use `--data-urlencode` for spaces, hashtags, and query operators. The query is passed to the search provider.

## Choose a feed

| `feed` | Results |
| --- | --- |
| `latest` | Recent matching posts. Default. |
| `top` | Top matching posts. |
| `photos` | Matching posts with photos. |
| `videos` | Matching posts with videos. |
| `users` | Matching account profiles. |

Feed names are case-insensitive. `media` is an alias for `photos`; unknown values fall back to `latest`.

```bash
# Photos
curl -sS 'https://x.pcstyle.dev/search?q=architecture&feed=photos'

# Videos
curl -sS 'https://x.pcstyle.dev/search?q=animation&feed=videos'

# People, with profile details
curl -sS 'https://x.pcstyle.dev/search?q=typescript&feed=users&full=true'
```

## Parameters

| Parameter | Default | Behavior |
| --- | --- | --- |
| `q` | Required | Nonempty search query. |
| `feed` | `latest` | One of the five feeds above. |
| `limit` | `20` | Results per response, maximum **20**. Larger values are clamped. |
| `cursor` | — | Opaque `nextCursor` from the previous response. |
| `page` | `1` | Page 1–10; prefer cursors for continuation. |
| `full` | `false` | `true` adds dates and metrics, or profile details for Users. |
| `format` | `markdown` | `markdown` or `json`. |
| `nocache` | `false` | `true` bypasses the application cache. |

Browse boolean parameters also accept `1`. [Pagination examples](/pagination).

## Read user results in JSON

Post feeds return a `posts` array. The Users feed returns a `users` array instead.

```js
const response = await fetch(
  'https://x.pcstyle.dev/search?q=typescript&feed=users&format=json'
)
if (!response.ok) throw new Error(`Search failed: ${response.status}`)
const { users, nextCursor } = await response.json()
for (const user of users) console.log(user.screen_name, user.name)
```

## Availability and limits

The hosted service allows **75 uncached search requests per minute per IP**. Cache hits do not consume this allowance. A `429` response includes `Retry-After` in seconds.

When live search is unavailable, Latest and Top may return web-indexed snippets. These responses include `X-Search-Degraded: true` and a note in the Markdown. Their ordering, coverage, and text can differ from live results, and they do not paginate.

Photos, Videos, and Users return `503` when their live source is unavailable. They never substitute unfiltered web snippets. See [errors and caching](/reliability).
