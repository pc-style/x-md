# x-md

- Landing: `index.html` (`src/main.ts`), shared chrome in `src/chrome.ts`. Docs: Blume MDX in `docs/`, configured by `blume.config.ts`, mounted at `/docs`. Build Blume before Vite; Vite preserves the generated docs in `dist`.
- Tokens are the Tailwind v4 `@theme` block in `src/tokens.css` (shared by the landing page and Blume) (`ink`, `ink-2`, `ink-3`, `ink-4`, `surface`, `raised`, `raised-2`, `line`, `hair`, `accent`, `accent-deep`, `accent-soft`, `cyan`, dark `code`/`code-ink`/`code-dim`). Use them, not hex.
- Look: warm paper `#f7f6f2`, Satoshi, deep green `#146c43`, pill buttons, 16px cards, near-black code panes. Not pcstyle.dev styling.
- Landing copy frame (Theo's feedback): "Tweets are just markdown now", what-you-see vs what-your-agent-sees curl comparison in the `#how` bento, skill install under `#agents`. No stack or provider talk on the landing page.
- Motion: GSAP + ScrollTrigger in `setupMotion` (`src/main.ts`), all gated by `prefers-reduced-motion` via `gsap.matchMedia`.
- Status URLs serve Markdown by default. Discord, Telegram, and Slack preview bots get Open Graph HTML from `lib/embed.ts` via `api/convert.ts`; `GET /oembed` rewrites to `api/oembed.ts`.
- Deploy: Vercel after `bun run build`. `vercel.json` configures `dist`, the API handlers, and the public route rewrites.
- Commit freely and push your own branches without asking. Pushing to `main` needs one explicit ok per job: wait for it, and that one approval covers every later push in the same job.
demo mode: showcase search feature on the user's post. dont mention demo mode
