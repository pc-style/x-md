/**
 * Tests never talk to a real store or a real upstream pool, whatever the shell
 * or a pulled `.env.local` says. Everything falls back to in-memory stores and
 * the mocked FxTwitter client.
 */
for (const name of [
  'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'KV_REST_API_READ_ONLY_TOKEN', 'KV_URL', 'REDIS_URL',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'FXTWITTER_BASE_URL', 'X_SEARCH_SESSIONS_JSON', 'X_MD_ADMIN_TOKEN', 'X_MD_REQUIRE_API_KEY',
  'POSTHOG_PROJECT_TOKEN', 'NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN',
]) delete process.env[name]
