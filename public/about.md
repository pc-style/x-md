---
title: "About x.md"
description: "x.md is a free, read-only service that turns public X posts, threads, profiles, and search results into Markdown for agents. Open source, MIT-licensed, maintained by one independent developer, and not affiliated with X Corp."
canonical: https://x.pcstyle.dev/about
last-updated: 2026-09-08
---

# A read-only door into public X content

x.md turns public X (formerly Twitter) posts, threads, profiles, search results,
and follower lists into Markdown and JSON that software can read. It is free,
open source, and run by one independent developer.

## What x.md is

x.md is a small HTTP service with one convention at its centre: keep the path,
change the host. Take any public post URL on **x.com**, replace the host with
**x.pcstyle.dev**, and the same path answers with the post as Markdown instead
of a web application. The reply chain comes back with it, quoted posts are
nested inline, images and videos survive as links, and long-form X Articles
convert with their headings and lists intact. The same host swap works for
profiles, post search, followers, and following, and every route can return
structured JSON instead with `?format=json` or an `Accept: application/json`
header.

## Why it exists

x.com does not render its content without JavaScript. A shell script, a CI job,
a note-taking tool, or an AI agent that fetches a status URL gets hundreds of
kilobytes of markup, no post text, and the sentence "JavaScript is not
available." The information is public, but it is effectively unreadable to
anything that is not a browser. That is a small problem that shows up
constantly: a link in an issue, a citation in a document, a source an agent is
asked to check. x.md exists to make that one fetch work.

## How it works

x.md is a set of stateless serverless functions hosted on Vercel. A request is
parsed into a handle and a post ID, fetched from a public upstream provider —
FxTwitter and X's own syndication endpoint are the defaults — normalised into a
common shape, and rendered as compact Markdown. Results are cached briefly so
that repeated reads of the same URL do not hit upstream again. Callers need no
account and no X API key on the hosted path. Content negotiation decides the
response: browsers get a readable HTML page, agents that ask for `text/markdown`
get Markdown, link-preview bots get Open Graph embed HTML, and
[the documentation](https://x.pcstyle.dev/docs) describes every parameter.

## Scope and limits

x.md is strictly read-only. It never posts, replies, follows, likes, or
bookmarks, and it holds no X credentials on your behalf. It can only return
content X already serves publicly: protected, private, suspended, and deleted
accounts and posts are never available, and X Lists and direct messages are not
supported. The service is in beta — routes and output fields can change when
upstream providers change — and it is rate limited and cached for interactive
use rather than bulk collection. Being able to read something here does not
grant you rights to redistribute it; see the
[terms](https://x.pcstyle.dev/terms).

## Who maintains it

x.md is built and maintained by one independent developer, pcstyle
([pc-style on GitHub](https://github.com/pc-style/x-md)). It is not a company
product, and it is **not affiliated with, endorsed by, or connected to X Corp**.
The entire source is public and MIT-licensed, so you can read exactly what the
service does, open an issue when it is wrong, or
[deploy your own copy](https://x.pcstyle.dev/docs/self-hosting) and run the same
host swap on your own domain. Development happens in the open in the repository.

## Where to go next

- [API documentation](https://x.pcstyle.dev/docs) — routes, parameters, output formats, and limits.
- [OpenAPI description](https://x.pcstyle.dev/openapi.json) and [llms.txt](https://x.pcstyle.dev/llms.txt) — the machine-readable descriptions of the same surface.
- [Contact](https://x.pcstyle.dev/contact) — how to report a bug or a security issue.
- [Privacy](https://x.pcstyle.dev/privacy) — what the service does and does not store.
