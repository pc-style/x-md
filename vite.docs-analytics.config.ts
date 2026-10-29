import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'

/**
 * The docs pages' analytics loader (`src/docs-analytics.ts`), built after the
 * site so it gets a chunk graph of its own. As a fourth entry of the main build
 * it pulled the modules it shares with the landing page (the PostHog wrapper,
 * the deferred-loading policy, Vite's preload helper) out into separate chunks,
 * which put four more requests in front of the landing page's first render.
 *
 * Blume builds first and names `/docs/analytics.js` in every docs page
 * (`blume.config.ts`), so the entry needs a stable path; its chunks are hashed
 * under `/assets/` like the rest.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  return {
    publicDir: false,
    define: {
      'import.meta.env.VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV ?? 'development'),
    },
    build: {
      emptyOutDir: false,
      modulePreload: { polyfill: false },
      rollupOptions: {
        input: { 'docs-analytics': resolve(import.meta.dirname, 'src/docs-analytics.ts') },
        output: { entryFileNames: 'docs/analytics.js' },
      },
    },
  }
})
