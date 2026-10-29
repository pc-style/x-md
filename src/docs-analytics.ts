import { whenUseful } from './deferred'

// The docs pages' PostHog, under the same production and privacy gating as the
// landing page's (`src/posthog.ts`). Blume renders this entry's script tag
// (`blume.config.ts`); the module itself waits for idle time or first intent.
whenUseful(() => import('./posthog'))
