---
title: "Authentication for x.md"
description: "x.md's public read API needs no credentials. This is the agent walkthrough: what discovery returns, why every WorkOS auth.md step is a no-op here, and how the optional bearer key for a higher search allowance actually works."
canonical: https://x.pcstyle.dev/auth.md
last-updated: 2026-09-08
---

# Authentication for x.md

**No authentication is required. Send the request.**

```sh
curl -H 'Accept: application/json' https://x.pcstyle.dev/api/v1/profiles/vercel
```

x.md is a read-only browser for content that is already public on X. There is
nothing to sign in to, no per-user data, and no write path, so the service
grants every caller the same public identity. An agent that arrives here looking
for a credential ceremony should stop and call the API.

This document follows the [WorkOS auth.md](https://github.com/workos/auth.md)
walkthrough section by section, because an agent that knows that spec should be
able to confirm, step by step, that each step is a no-op here rather than
guessing. Everything below describes the hosted service at
`https://x.pcstyle.dev`. Self-hosted deployments are configured by their own
operator.

## Discover

The two-hop OAuth discovery in the spec does not resolve here, by design:

- `GET /.well-known/oauth-protected-resource` — **not served.** x.md publishes no
  Protected Resource Metadata, so there is no `resource`, `resource_name`,
  `authorization_servers`, or `scopes_supported` document to read.
- `GET /.well-known/oauth-authorization-server` — **not served.** There is no
  authorization server, therefore no `agent_auth` block and no
  `identity_endpoint`, `claim_endpoint`, or `events_endpoint`.

A successful read also never challenges you: public routes do not return a
`WWW-Authenticate` header, so the trigger that would normally start discovery
never fires. If you probe those paths you will get x.md's ordinary RFC 9457
`404` problem document with `"code": "route_not_found"`, not an OAuth error.

What discovery *does* return here is capability, not credentials:

| Document | What it tells you |
| --- | --- |
| [`/.well-known/ard.json`](https://x.pcstyle.dev/.well-known/ard.json) | Every machine surface x.md publishes |
| [`/.well-known/api-catalog`](https://x.pcstyle.dev/.well-known/api-catalog) | RFC 9727 linkset for the REST API |
| [`/openapi.json`](https://x.pcstyle.dev/openapi.json) | Every route, parameter, and response schema |
| [`/mcp`](https://x.pcstyle.dev/mcp) | The same reads as MCP tools |

Treat the absence of an authorization server as the answer, not as an error to
retry.

## Pick a method

The spec's decision tree has three branches. On x.md all three collapse to the
same one:

- **`identity_assertion` (ID-JAG).** Not supported. x.md accepts no `id-jag`
  token, no JWT bearer assertion, and no federated identity from your host
  agent platform. Do not attempt RFC 7523 exchange.
- **`service_auth` (register by email).** Not supported. There is no email
  registration, no verification mail, and no account object.
- **Anonymous.** This is the only method, and it needs no registration. Issue
  the request with no `Authorization` header.

One narrow exception exists and it is not a method you can select: a static
bearer key, issued by hand, that raises the search allowance. See
[Use the access_token](#use-the-access_token) for what it does and
[Register](#register) for how a human asks for one.

## Register

Nothing to register for public reads. Skip this step.

There is no `identity_endpoint` to `POST` to, so the three registration
responses in the spec — direct success, `interaction_required`, and
`login_required` — have no equivalent here, and an agent should not branch on
them.

If a project genuinely needs a higher search allowance than the public one, a
**human** asks for a key by opening an issue at
<https://github.com/pc-style/x-md/issues> describing the workload. Keys are
created by the maintainer in a private admin dashboard, handed over
out-of-band, and shown once. There is no self-service issuance endpoint, and an
agent cannot obtain a key on its own — that is deliberate, because the key
grants a share of a small pooled resource rather than access to private data.
Everything an agent can read with a key, it can also read without one.

## Claim

There is no claim ceremony. x.md issues no `claim_token`, no `user_code`, and no
`verification_uri`, and there is nothing to poll: no `token_endpoint`, and no
`urn:workos:agent-auth:grant-type:claim` grant.

If your framework requires a user-consent handoff before a tool call, note what
consent would even cover here: x.md reads public X content on your behalf and
holds no user account, no scopes, and no delegated permissions.

## Exchange

There is no assertion to exchange and no `token_endpoint` to exchange it at.
Skip this step. Any key you may have been given is already the final
credential — it is an opaque string, not the output of a grant, and it is never
refreshed, rotated, or minted by an exchange.

## Use the access_token

Anonymous callers send nothing:

```sh
curl https://x.pcstyle.dev/search?q=typescript
```

A caller who was given a key presents it as an ordinary bearer credential:

```sh
curl -H 'Authorization: Bearer xmd_<secret>' \
     -H 'Accept: application/json' \
     'https://x.pcstyle.dev/api/v1/search?q=typescript&feed=latest'
```

Facts worth knowing before you wire it up:

- Only the `Bearer` scheme is read. `Basic`, query-string keys, and custom
  headers are ignored.
- The key affects the browse surface only — search, profiles, followers,
  following, and the MCP server. Post conversion (`/{handle}/status/{id}`,
  `/api/v1/posts`) ignores the header entirely and is always public.
- The response echoes `X-Api-Key-Status: valid | anonymous | invalid |
  unverified` so you can confirm which allowance you were actually given.
- Keyed responses are marked `Cache-Control: private, no-store` and are never
  served from the shared CDN cache.
- `unverified` means the key store was unreachable and your request was served
  with the public allowance instead of failing. Treat it as a soft degradation,
  not an auth error.
- The credential does not expire on a clock and there is no refresh flow. Keep
  it out of URLs, logs, prompts, and tool output.

## Errors

x.md answers errors as RFC 9457 problem documents
(`application/problem+json`) carrying a stable machine `code` and a
`resolution` hint.

| Status | `code` | What happened | What to do |
| --- | --- | --- | --- |
| `401` | `invalid_key` | The presented bearer key is unknown or disabled | Drop the `Authorization` header and call anonymously, or ask for a replacement key. Never retry the same key in a loop |
| `401` | `unauthorized` | You reached a private admin route | Not part of the public API. Use `/openapi.json` to find the public one |
| `404` | `route_not_found` | No such API route | Discover the surface at `/api`, `/openapi.json`, or `/.well-known/api-catalog` |
| `429` | rate limit | Allowance exhausted for this window | Read `Retry-After` and wait exactly that many seconds |
| `503` | upstream | A public X provider is down | Retry after `Retry-After: 30` |

No public error carries a `WWW-Authenticate` header, so a `401` from x.md is
never an invitation to start an OAuth flow — it means the key you sent is bad,
or the route is not yours to call.

## Revocation

- **You revoke by discarding.** There is no token to invalidate for an
  anonymous caller, and a key can simply be dropped.
- **The operator revokes centrally.** The maintainer can disable or delete a key
  from the admin dashboard; the next request with it returns `401 invalid_key`
  immediately. There is no self-service `revocation_endpoint` (RFC 7009) and no
  Security Event Token delivery (RFC 8935) — there is no `events_endpoint` to
  deliver one to.
- **To rotate**, ask for a new key in the same GitHub issue thread and stop
  using the old one; the maintainer deletes it.
- Only the SHA-256 hash of a key is stored, so a leaked store cannot yield a
  usable credential. A leaked *key* still can — report it privately through the
  repository's Security tab, per
  [SECURITY.md](https://github.com/pc-style/x-md/blob/main/SECURITY.md), and it
  will be deleted.

## Related

- [Pricing and limits](https://x.pcstyle.dev/pricing.md)
- [Agent guide](https://x.pcstyle.dev/agents.md)
- [Errors, limits, and caching](https://x.pcstyle.dev/docs/reliability)
