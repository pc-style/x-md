---
title: "x.md pricing"
description: "x.md is free. There is no paid tier, no metering, and no billing. Rate limits are the only cost dimension; this file states them in a form an agent can compare."
canonical: https://x.pcstyle.dev/pricing.md
last-updated: 2026-09-08
currency: USD
price: 0
contact: https://github.com/pc-style/x-md/issues
---

# x.md pricing

**x.md is free. $0.00. There is no paid plan, no trial, no metering, no
invoice, and no payment method on file.**

It is an MIT-licensed open-source project run by one developer on Vercel. What
would be "price" on a commercial API is, here, a rate limit: a small shared
allowance that keeps a free service usable for everyone. Compare on limits, not
on cost.

Currency: USD. Last updated: 2026-09-08. Canonical source:
<https://x.pcstyle.dev/pricing.md>.

## Plans

| Plan | Price | Interval | Best for | Includes | Limits |
| --- | ---: | --- | --- | --- | --- |
| Public | $0 | none | Every caller, including agents | All read routes, Markdown and JSON, OpenAPI, MCP, the `browse-x` skill | 5 uncached live searches per minute per IP; a further shared live-provider allowance per IP per 15-minute window; 20 items per page; 10 pages maximum |
| Keyed | $0 | none | A project that outgrew the public search allowance | Everything in Public, plus a per-key share of the account search pool | Per-key allowance per 15 minutes, set when the key is issued; issued by hand, not self-serve |
| Self-hosted | $0 | none | Anyone who wants their own limits, providers, or private deployment | The full source under MIT | Your infrastructure, your provider keys, your bill |

There is no enterprise tier, no seat count, no SLA, and no support contract. If
you need any of those, self-host: `git clone https://github.com/pc-style/x-md`.

## Usage rules

- **Meter:** requests that reach the live search provider. Cache hits are free
  and do not count.
- **Reset:** the per-minute counter resets every 60 seconds; the shared
  allowance resets on a 15-minute window boundary.
- **Overage behaviour:** none. There is no overage billing — a request over the
  limit is refused with `429` and a `Retry-After` in seconds. Wait that long
  and retry once; do not loop, and do not spread the same workload across IPs.
- **Caching:** successful anonymous responses are cached about an hour, so
  re-reading the same public post costs nothing. A keyed response is
  `Cache-Control: private, no-store` and never enters the shared cache; it still
  reads x.md's own result cache, so the repeat read is free either way.
- **Page walks:** each page of a `page=` walk counts as one request. Prefer the
  `cursor` from `nextCursor`, which costs one upstream page.
- **Not included at any price:** private, protected, or deleted content; X
  Lists; direct messages; writes of any kind; bulk export or firehose access.

## Terms

- **Billing:** none. No card, no ACH, no wire, no invoice, no renewal, and
  therefore no cancellation or refund — there is nothing to cancel or refund.
- **Commitment:** none, in both directions. The hosted service is provided as
  is, without warranty, and may change or stop. See
  [/terms](https://x.pcstyle.dev/terms).
- **Licence:** MIT for the source. The X content x.md renders belongs to its
  authors and to X; x.md grants you no rights over it.
- **Status:** beta. Routes and output fields can change as upstream X providers
  change.

## Procurement

- Security review: [SECURITY.md](https://github.com/pc-style/x-md/blob/main/SECURITY.md)
  and [/.well-known/security.txt](https://x.pcstyle.dev/.well-known/security.txt).
- Data handling: [/privacy](https://x.pcstyle.dev/privacy) and the
  [optional data archive](https://x.pcstyle.dev/docs/archive) policy.
- SLA, DPA, vendor forms, uptime credits: not offered. This is a free
  best-effort project, not a vendor.

## Action path

1. Just call it. `curl https://x.pcstyle.dev/{handle}/status/{id}` — no signup,
   no key. See [/auth.md](https://x.pcstyle.dev/auth.md).
2. Hitting `429` repeatedly on legitimate interactive use? Open an issue at
   <https://github.com/pc-style/x-md/issues> describing the workload and ask
   about a key.
3. Need capacity, privacy, or control beyond that? Self-host; the guide is at
   [/docs/self-hosting](https://x.pcstyle.dev/docs/self-hosting).

## Change policy

Pricing is $0 and there is no mechanism to charge, so there is no price to
change. Rate limits can change with upstream provider capacity; the current
values live here, in [/llms.txt](https://x.pcstyle.dev/llms.txt), and in
[/docs/reliability](https://x.pcstyle.dev/docs/reliability), and changes are
recorded in the repository
[CHANGELOG](https://github.com/pc-style/x-md/blob/main/CHANGELOG.md).
