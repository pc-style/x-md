---
title: Posts and threads
description: Read a single post, follow an author's thread, or include the surrounding conversation.
sidebar:
  order: 1
---

## Read a post

`GET /{handle}/status/{id}`

```bash
curl -sS 'https://x.pcstyle.dev/trq212/status/2052809885763747935?thread=off'
```

Without `thread=off`, the default response includes available parents, the author's thread, and top replies. Each returned post links to its X source.

## Control the conversation

```bash
# Author thread, capped at 20 posts
curl -sS 'https://x.pcstyle.dev/trq212/status/2052809885763747935?context=thread&thread=20'

# Expanded details, without unrelated replies
curl -sS 'https://x.pcstyle.dev/trq212/status/2052809885763747935?full=true&replies=off'
```

| Parameter | Default | Values |
| --- | --- | --- |
| `thread` | `full` | `off`, `full`, `conversation`, or a count from `2` to `100` |
| `context` | `full` | `full` for surrounding context; `thread` for the direct author chain |
| `replies` | `top` | `top`, `recent`, `off` |
| `userinfo` | `off` | `off`, `author`, `all` |
| `full` | `false` | `true` adds dates, stats, and expanded details |
| `format` | `markdown` | `markdown`, `json`, `obsidian` |
| `nocache` | `false` | `true` bypasses application caching |

Post boolean parameters accept `true`, `1`, or `yes`. The thread count is separate from the 20-result limit on search and profile routes.

## Pass the original URL

If your app already holds an X URL, use the query endpoint:

```bash
curl -sS -G 'https://x.pcstyle.dev/api/convert' \
  --data-urlencode 'url=https://x.com/trq212/status/2052809885763747935' \
  --data-urlencode 'thread=off'
```

## Media and articles

Responses include available image links, video URLs, thumbnails, and media variants. X Articles are included when the source supplies their content. Media is linked, not downloaded; CDN links can expire.

Missing or gated context can produce a shorter thread. Inspect JSON `warnings` before assuming a conversation is complete.

## Save to Obsidian

```bash
curl -sS 'https://x.pcstyle.dev/trq212/status/2052809885763747935?format=obsidian' > post.md
```

Obsidian output includes frontmatter and expanded details regardless of `full`.

## Share in chat

Paste an x.md status URL into Discord, Telegram, or Slack for a rich preview. Preview bots receive Open Graph HTML. Ordinary requests receive Markdown; explicit `format` or `Accept` takes precedence.

`GET /oembed?url={original X URL}` returns the oEmbed metadata.
