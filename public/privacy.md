---
title: "x.md privacy"
description: "x.md has no sign-in and no user accounts. What happens to a request: IP used only for rate-limit counters, one-hour caching of public content, optional metadata-only analytics, one optional cookie, and an opt-in public-result archive that is disabled by default."
canonical: https://x.pcstyle.dev/privacy
last-updated: 2026-09-08
---

# No accounts, no profiles, very little kept

x.md has no sign-in and no user accounts, so there is nothing to build a profile
from. This page describes what actually happens to a request, taken from the
code in the public repository.

## No accounts, no credentials

There is no registration, login, password, or session. x.md never asks for your
X credentials, cannot act on an X account, and has no way to associate a request
with a person. Private API keys exist for a small number of callers who need a
larger search allowance; they are handed out privately, only a SHA-256 hash of
the secret is stored, and they carry a label and a limit — not a person.

## What a request necessarily involves

Like any website, your request reaches Vercel's edge with an IP address and
ordinary HTTP headers, and Vercel operates the hosting and CDN under its own
terms. Inside the application, the client IP address is read from the standard
proxy headers for one purpose: rate limiting. It becomes part of a counter key
in a key/value store, the counter holds only a number, and the key expires
automatically — roughly two minutes for the per-minute search gate and about
half an hour for the fifteen-minute search budget. No URL, query, response, or
header is written beside it. Rate limits protect scarce upstream capacity, above
all for live search.

## Caching

Conversion and browse results are cached under a key derived from the request
parameters, in the serverless instance's memory and at Vercel's CDN, for one
hour by default. What is cached is public X content, not anything about you, and
`?nocache=true` bypasses it. Responses to requests that carry an API key are
marked `private, no-store` so they can never be served from a shared cache to
somebody else.

## Analytics

Two optional, metadata-only instrumentations run on the production deployment
when they are configured. Neither one is required for the service to work, and
both are absent from local and preview builds.

- **Server-side request counting.** One event per completed production function
  response, carrying only the route name, HTTP method, status code, duration in
  milliseconds, cache outcome, whether the caller used a key, and the
  environment. The request URL, query, headers, body, and error text are never
  serialised. Person profiles and GeoIP enrichment are disabled and the IP field
  is explicitly sent as null. Anonymous callers get a fresh random identifier per
  request, so events cannot be linked across requests; API-key callers get an
  HMAC of the internal key ID, never the key itself.
- **Landing-page analytics.** The homepage — and only the homepage — may load
  PostHog to count page views, page leaves, and two interactions: requesting a
  conversion and copying the skill install command. Properties are reduced to an
  allowlist of browser, device, viewport, and session fields; the reported URL is
  rewritten to the bare origin so query strings and referrers are not sent.
  Autocapture, session recording, heatmaps, surveys, exception capture, and
  person profiles are all switched off. Vercel Web Analytics is also injected on
  the landing page.

## Cookies and local storage

The API sets no cookies at all. In the browser, x.md stores your light/dark theme
choice in `localStorage` under `x-md-theme`, and the analytics library, when it
runs, keeps its own anonymous identifier there. One optional cookie exists,
`__Host-xmd_actor`: it holds an anonymous UUID, is set only in builds where the
operator has enabled the archive actor bridge, and is scoped
`Secure; SameSite=Lax; Path=/` with a 30-day lifetime. Opting out writes a second
cookie, `__Host-xmd_archive_optout=1`, which the server also honours.

## The optional public-result archive

The repository contains an opt-in capture path that sends the structured public
results of successful GET responses — post fields, public author fields, media
metadata — to PostHog for later export. It is **disabled by default** and
requires an operator to set an explicit environment flag plus a separate
server-only secret; it never runs in local or preview builds. Its payloads use
strict field allowlists that exclude rendered response bodies, incoming URLs and
search queries, request headers, IP addresses, credentials, and cursors, and
protected authors are excluded entirely.

## Your controls

- Send `DNT: 1`, `Sec-GPC: 1`, or `X-Xmd-Archive-Opt-Out: 1` with a request, or
  set the `__Host-xmd_archive_optout=1` cookie: archive capture is skipped and
  the landing-page analytics do not initialise.
- Use `?nocache=true` to bypass the application cache for a request.
- Block the third-party requests listed below, or run the service yourself — a
  [self-hosted deployment](https://x.pcstyle.dev/docs/self-hosting) with no
  analytics variables configured sends nothing anywhere.

## Third parties

Serving a request involves Vercel (hosting and CDN) and the upstream public X
endpoints and FxTwitter that supply the content. When analytics are configured,
events go to a PostHog instance. Loading the landing page in a browser
additionally fetches a web font from Fontshare and a Product Hunt badge image;
both are ordinary third-party requests made by your browser and can be blocked
without affecting the API.

## Changes

This page describes the behaviour of the code in the public repository, which is
the authoritative record — every claim above can be checked against
[the source](https://github.com/pc-style/x-md). Questions and corrections go to
[contact](https://x.pcstyle.dev/contact). Last reviewed 8 September 2026.
