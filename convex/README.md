# Convex monetization model

This directory defines the planned Convex backend for x.md premium accounts.

Tables:

- `users`: Clerk user ID, Autumn customer ID, profile metadata.
- `apiKeys`: hashed `xmd_...` API tokens for agent/API access.
- `requestLogs`: anonymous/free and authenticated premium request audit trail.
- `featureRuns`: premium entitlement checks and usage records.
- `billingCustomers`: local mirror of Autumn/Stripe customer state for account UI/debugging.

Deploy Convex separately from Vercel with `bunx convex deploy` once the project is linked and `CONVEX_DEPLOYMENT` / `NEXT_PUBLIC_CONVEX_URL` are configured.
