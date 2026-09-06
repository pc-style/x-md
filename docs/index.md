---
title: Start reading X
description: Turn a public X URL into Markdown. No API key, login, or SDK needed.
sidebar:
  label: Quickstart
  order: 0
---

## Make your first request

Replace `x.com` with `x.pcstyle.dev` in a post URL. Keep the handle and status ID.

```bash
curl -sS 'https://x.pcstyle.dev/trq212/status/2052809885763747935'
```

You get readable Markdown with the post text, source links, and available thread context. Add `?thread=off` to read only the requested post.

## Search instead

```bash
curl -sS -G 'https://x.pcstyle.dev/search' \
  --data-urlencode 'q=typescript' \
  --data-urlencode 'feed=latest'
```

Search returns up to **20 results**. Choose Latest, Top, Photos, Videos, or Users with the `feed` parameter.

## Get structured data

Use `format=json` when your code needs fields instead of prose.

```js
const response = await fetch(
  'https://x.pcstyle.dev/search?q=typescript&feed=latest&format=json'
)
if (!response.ok) throw new Error(`x.md returned ${response.status}`)
const { posts, nextCursor } = await response.json()
console.log(posts, nextCursor)
```

JSON includes the rendered `markdown` too. [See response formats](/responses).

## Choose your next step

| You want to… | Read |
| --- | --- |
| Read a post, thread, or replies | [Posts and threads](/posts) |
| Find posts, photos, videos, or people | [Search](/search) |
| Read an account and its connections | [Profiles and connections](/profiles) |
| Give your agent access to X | [Agent skill](/agents) |
| Fetch the next page | [Pagination](/pagination) |

x.md reads public content. Private posts and X Lists are unavailable.
