/**
 * The landing page markup.
 *
 * Kept as a pure string builder with no DOM or CSS imports so the Vite config
 * can render it into `index.html` at build time. Agents and crawlers then read
 * the full page from the raw HTML; `main.ts` only wires up behaviour on top.
 */
import { footerHtml, headerHtml } from './chrome'

const EXAMPLE_HANDLE = 'trq212'
const EXAMPLE_ID = '2052809885763747935'
const EXAMPLE_X_URL = `https://x.com/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_PATH = `/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`

const SKILL_CMD = 'bunx skills add pc-style/x-md -g -y'

const xComOutput = `<span class="t-dim">&lt;!DOCTYPE html&gt;&lt;html lang="en" dir="ltr"
data-app-env="prod"&gt;&lt;head&gt;&lt;meta charSet="utf-8"
nonce="JCApsPM44mDDnid3Yl…"&gt;&lt;meta
name="viewport" content="width=device-width…</span>

<span class="t-dim">…hundreds of KB of markup,
zero post text…</span>

<span class="t-bad">JavaScript is not available.</span>`

/* real trimmed output from the hosted converter for the example post */
const mdOutput = `<span class="t-key">## 1/2 — Thariq (@trq212)</span>

<span class="t-dim">Source:</span> x.com/${EXAMPLE_HANDLE}/status/…
<span class="t-dim">Stats:</span> 17,717 likes · 14.4M views

<span class="t-key">## Using Claude Code: The
   Unreasonable Effectiveness
   of HTML</span>

Markdown has become the dominant
file format used by agents to
communicate with us…`

const heroCard = `<span class="t-key">## 1/2 — Thariq (@trq212)</span>

<span class="t-dim">Source:</span> ${EXAMPLE_X_URL}
<span class="t-dim">Stats:</span> 17,717 likes · 2,275 reposts

<span class="t-key">## Using Claude Code: The Unreasonable
   Effectiveness of HTML</span>

Markdown has become the dominant file
format used by agents to communicate
with us…`

const MARQUEE_ITEMS = [
  'Full threads by default',
  '?format=obsidian',
  'Quote posts nested inline',
  'Images and video preserved',
  'X Articles, headings and all',
  'text/markdown response',
  '?thread=off for a single post',
  'No account, no API key required',
]

const marqueeTrack = MARQUEE_ITEMS.map(
  (item) => `<span class="flex items-center gap-10"><span>${item}</span><span aria-hidden="true" class="text-accent">·</span></span>`,
).join('')

type Resource = { href: string; title: string; blurb: string; hint: string; external?: boolean }

/** Documentation and the machine-readable descriptions of the same API surface. */
const RESOURCES: Resource[] = [
  {
    href: '/docs',
    title: 'API documentation',
    blurb: 'Every route, query parameter, output format, pagination rule, error code, and rate limit.',
    hint: '/docs',
  },
  {
    href: '/docs/posts',
    title: 'API reference: posts and threads',
    blurb: 'Conversion parameters for a single post, a thread, a conversation, or an X Article.',
    hint: '/docs/posts',
  },
  {
    href: '/openapi.json',
    title: 'OpenAPI 3.1 description',
    blurb: 'The whole read-only API as a machine-readable contract you can generate a client from.',
    hint: '/openapi.json',
  },
  {
    href: '/mcp',
    title: 'MCP server',
    blurb: 'Model Context Protocol endpoint, so an MCP client can read X without a browser.',
    hint: '/mcp',
  },
  {
    href: '/llms.txt',
    title: 'llms.txt',
    blurb: 'A short, plain-text briefing on the routes and limits, written for language models.',
    hint: '/llms.txt',
  },
  {
    href: 'https://github.com/pc-style/x-md',
    title: 'Source on GitHub',
    blurb: 'MIT-licensed. Read exactly what the service does, file an issue, or self-host it.',
    hint: 'github.com/pc-style/x-md',
    external: true,
  },
]

const RESOURCE_CARDS = RESOURCES.map(
  (item) => `<a href="${item.href}" class="res-card"${item.external ? ' target="_blank" rel="noreferrer"' : ''}>
            <h3 class="text-[17px] font-bold text-ink">${item.title}</h3>
            <p class="mt-2.5 text-[14.5px] leading-relaxed text-ink-2">${item.blurb}</p>
            <span class="res-card-hint">${item.hint}</span>
          </a>`,
).join('\n          ')

/**
 * Shared with the FAQPage JSON-LD in `index.html`, which must repeat these
 * strings verbatim: structured data may only describe content the page shows.
 */
export const FAQ: { question: string; answer: string }[] = [
  {
    question: 'Do I need an X or Twitter API key to use x.md?',
    answer:
      'No. The hosted service reads public X content through public upstream providers, so there is no X API key, no developer account, and no sign-in of any kind. Rate limits take the place of authentication.',
  },
  {
    question: 'Does it return whole threads, or only a single post?',
    answer:
      'Whole threads by default. A status URL returns the conversation: parent posts, the author thread numbered in order, and top replies. Add ?thread=off for only the requested post, or ?context=thread to leave out unrelated replies.',
  },
  {
    question: 'Can x.md read private, protected, or deleted posts?',
    answer:
      'No. x.md only returns what X already serves publicly. Protected and private accounts, suspended accounts, and deleted posts are never available, and X Lists and direct messages are not supported.',
  },
  {
    question: 'Is there a rate limit?',
    answer:
      'Yes. Live search is the scarce path: public callers get 5 uncached searches per minute per IP address, plus a further per-IP budget over a fifteen-minute window. Post and profile reads are cached for an hour by default, so repeat reads of the same URL usually never reach upstream.',
  },
  {
    question: 'Can x.md post, reply, follow, or like on my behalf?',
    answer:
      'No. x.md is strictly read-only. It has no write path to X, never holds your credentials, and cannot act on any account.',
  },
  {
    question: 'What output formats are available?',
    answer:
      'Compact Markdown by default. Add ?full=true for dates and metrics, ?format=obsidian for YAML frontmatter, or ?format=json (or an Accept: application/json header) for structured JSON carrying both the rendered Markdown and the raw post data.',
  },
  {
    question: 'How do I point an agent at it?',
    answer:
      'Three ways: tell the agent in its prompt to swap x.com for x.pcstyle.dev, install the browse-x skill, or call the documented HTTP API described at /docs, /openapi.json, and /mcp.',
  },
]

const FAQ_ITEMS = FAQ.map(
  (item) => `<div>
            <h3 class="text-[18px] leading-snug font-bold text-ink">${item.question}</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">${item.answer}</p>
          </div>`,
).join('\n          ')

export function landingHtml(): string {
  return `
<div class="x-root w-full max-w-full overflow-x-hidden">
  <a href="#convert" class="skip-link">Skip to converter</a>
  ${headerHtml({ page: 'landing' })}

  <main id="top" class="w-full max-w-full overflow-x-hidden">

    <!-- hero: artistic asymmetry -->
    <section class="relative overflow-hidden">
      <div class="hero-wash"></div>
      <div class="mx-auto grid max-w-[1200px] gap-14 px-6 pt-20 pb-24 sm:px-8 sm:pt-28 lg:grid-cols-12 lg:gap-8 lg:pb-36">
        <div class="lg:col-span-7" data-hero-stagger>
          <p class="eyebrow eyebrow-accent">Open source · Free · No account</p>
          <h1 class="hero-h mt-5 max-w-[13ch] text-[clamp(2.9rem,6.2vw,5.2rem)] leading-[1.02] font-black text-ink">
            Tweets are just markdown now.
          </h1>
          <p class="mt-7 max-w-[46ch] text-[16px] leading-[1.75] text-ink-2 sm:text-[17px]">
            Treat them that way. Swap <code class="code-chip">x.com</code> for
            <code class="code-chip">x.pcstyle.dev</code> in any public post URL and the
            post, its thread, or the full article comes back as Markdown your agent can read.
          </p>

          <div id="convert" class="mt-10 max-w-[640px] scroll-mt-28">
            <div class="convert-shell">
              <form data-convert-form class="flex flex-col gap-2 sm:flex-row sm:items-stretch">
                <label for="x-url" class="sr-only">X status URL</label>
                <input
                  id="x-url"
                  data-convert-input
                  type="url"
                  name="url"
                  required
                  inputmode="url"
                  autocomplete="off"
                  spellcheck="false"
                  placeholder="https://x.com/handle/status/…"
                  value="${EXAMPLE_X_URL}"
                  class="convert-input"
                />
                <button type="submit" class="btn-primary h-[50px] shrink-0 px-6 text-[14px] sm:min-w-[160px]">
                  Get Markdown
                </button>
              </form>
              <p class="mt-3 px-1.5 text-[12.5px] leading-relaxed text-ink-4">
                Opens the converted post in a new tab — the same result as swapping the host by hand.
              </p>
            </div>
          </div>
        </div>

        <div class="lg:col-span-5 lg:self-end" data-hero-card>
          <div class="float-card lg:-mr-6 lg:-mb-10">
            <div class="float-card-bar">
              <span class="truncate">x.pcstyle.dev${EXAMPLE_PATH}</span>
              <span class="pane-tag pane-tag-good">text/markdown</span>
            </div>
            <pre>${heroCard}</pre>
          </div>
        </div>
      </div>
    </section>

    <!-- marquee -->
    <div class="marquee" aria-hidden="true">
      <div class="marquee-track">
        ${marqueeTrack}
        ${marqueeTrack}
      </div>
    </div>

    <!-- interest: gapless bento, before / after -->
    <section id="how" class="scroll-mt-28">
      <div class="mx-auto max-w-[1200px] px-6 py-28 sm:px-8 md:py-40">
        <h2 class="max-w-[22ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          You see the same post either way. Your agent doesn't.
        </h2>
        <div class="bento mt-14">
          <article class="bento-card bento-a bento-dark" data-rise-card>
            <div class="flex items-center justify-between gap-3">
              <p class="min-w-0 truncate font-mono text-[12px]" style="color: var(--color-code-dim)">$ curl x.com${EXAMPLE_PATH}</p>
              <span class="pane-tag pane-tag-bad shrink-0">no content</span>
            </div>
            <pre class="mt-6 overflow-x-auto font-mono text-[12.5px] leading-[1.8] whitespace-pre" style="color: var(--color-code-ink)">${xComOutput}</pre>
          </article>
          <article class="bento-card bento-b bento-dark" data-rise-card>
            <div class="flex items-center justify-between gap-3">
              <p class="min-w-0 truncate font-mono text-[12px]" style="color: var(--color-code-dim)">$ curl x.pcstyle.dev${EXAMPLE_PATH}</p>
              <span class="pane-tag pane-tag-good shrink-0">markdown</span>
            </div>
            <pre class="mt-6 overflow-x-auto font-mono text-[12.5px] leading-[1.8] whitespace-pre" style="color: var(--color-code-ink)">${mdOutput}</pre>
          </article>
          <article class="bento-card bento-c bento-tint" data-rise-card>
            <h3 class="text-[19px] font-bold text-ink">One host swap, nothing else</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              Same path, same status ID. That's a real post converted live:
              <a href="${EXAMPLE_PATH}?thread=full" target="_blank" rel="noreferrer" class="font-bold text-accent hover:text-accent-deep">see the full conversion →</a>
            </p>
          </article>
          <article class="bento-card bento-d" data-rise-card>
            <h3 class="text-[19px] font-bold text-ink">Pipe it anywhere</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              The response is plain <code class="code-chip">text/markdown</code>, so
              <code class="code-chip">curl … &gt; post.md</code> drops a tweet straight into your vault.
            </p>
          </article>
        </div>
      </div>
    </section>

    <!-- desire: scrubbing statement -->
    <section class="border-t border-line">
      <div class="mx-auto max-w-[1000px] px-6 py-28 sm:px-8 md:py-44">
        <p data-scrub-text class="text-[clamp(1.6rem,3.4vw,2.7rem)] leading-[1.35] font-bold tracking-tight text-ink">
          Your notes, your scripts, and your agents all speak Markdown. X speaks JavaScript. x.md is the translation layer: keep the URL, change the host, read the post.
        </p>
      </div>
    </section>

    <!-- desire: pinned split, what comes through -->
    <section data-pin-section class="border-t border-line">
      <div class="mx-auto grid max-w-[1200px] gap-12 px-6 py-28 sm:px-8 md:py-40 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
        <div>
          <div data-pin-target class="lg:pr-8">
            <h2 class="max-w-[14ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
              Nothing important gets dropped.
            </h2>
            <p class="mt-5 max-w-[40ch] text-[15.5px] leading-relaxed text-ink-3">
              Conversion keeps the parts that matter when you're saving a post for later — or feeding it to a model.
            </p>
          </div>
        </div>
        <div>
          <div class="through-item">
            <h3 class="text-[21px] font-bold text-ink">Threads</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
              The full reply chain comes back by default, numbered in order.
              Add <code class="code-chip">?thread=off</code> when you only want the one post.
            </p>
          </div>
          <div class="through-item">
            <h3 class="text-[21px] font-bold text-ink">Media</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
              Images and video survive as Markdown links instead of disappearing into a player.
            </p>
          </div>
          <div class="through-item">
            <h3 class="text-[21px] font-bold text-ink">Quote posts</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
              Quoted posts are nested inline where they appear, not dropped or reduced to a bare link.
            </p>
          </div>
          <div class="through-item">
            <h3 class="text-[21px] font-bold text-ink">X Articles</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
              Long-form articles convert with their full body — headings, lists, and embedded posts included.
            </p>
          </div>
          <div class="through-item">
            <h3 class="text-[21px] font-bold text-ink">Obsidian frontmatter</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">
              <code class="code-chip">?format=obsidian</code> adds YAML frontmatter with author,
              date, and source URL, ready for your vault.
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- agents: horizontal accordion -->
    <section id="agents" class="deferred-section scroll-mt-28 border-t border-line">
      <div class="mx-auto max-w-[1200px] px-6 py-28 sm:px-8 md:py-40">
        <h2 class="max-w-[20ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          Three ways to point an agent at it.
        </h2>
        <div class="acc mt-14">
          <div class="acc-item" data-open>
            <button type="button" class="acc-trigger" aria-expanded="true" aria-controls="agent-panel-prompt">
              <span class="acc-num block">for any agent</span>
              <span class="mt-3 block text-[20px] font-bold text-ink">Say it in the prompt</span>
            </button>
            <div id="agent-panel-prompt" class="acc-body">
              <p class="max-w-[44ch] text-[14.5px] leading-relaxed text-ink-2">
                One line is enough: <span class="font-medium text-ink">"To read an X post, swap
                x.com for x.pcstyle.dev."</span> Every agent that can fetch a URL now reads tweets.
              </p>
            </div>
          </div>
          <div class="acc-item">
            <button type="button" class="acc-trigger" aria-expanded="false" aria-controls="agent-panel-skill">
              <span class="acc-num block">for skills-aware agents</span>
              <span class="mt-3 block text-[20px] font-bold text-ink">Install the skill</span>
            </button>
            <div id="agent-panel-skill" class="acc-body">
              <p class="max-w-[44ch] text-[14.5px] leading-relaxed text-ink-2">
                One command teaches Amp, Claude Code, and friends the host swap permanently.
              </p>
              <div class="cmd-row mt-5 max-w-[460px]">
                <code><span class="t-dim">$ </span>${SKILL_CMD}</code>
                <button type="button" class="copy-btn" data-copy="${SKILL_CMD}">Copy</button>
              </div>
            </div>
          </div>
          <div class="acc-item">
            <button type="button" class="acc-trigger" aria-expanded="false" aria-controls="agent-panel-api">
              <span class="acc-num block">for scripts</span>
              <span class="mt-3 block text-[20px] font-bold text-ink">Call the API</span>
            </button>
            <div id="agent-panel-api" class="acc-body">
              <p class="max-w-[44ch] text-[14.5px] leading-relaxed text-ink-2">
                <code class="code-chip">GET /api/v1/posts?url=…</code> returns the same Markdown
                with JSON and raw variants. Every route, parameter, and limit is written down in the
                <a href="/docs" class="font-bold text-accent hover:text-accent-deep">API documentation</a>
                and described again in
                <a href="/openapi.json" class="font-bold text-accent hover:text-accent-deep">OpenAPI</a>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- documentation: crawlable links to every published surface -->
    <section id="resources" class="deferred-section scroll-mt-28 border-t border-line">
      <div class="mx-auto max-w-[1200px] px-6 py-28 sm:px-8 md:py-40">
        <h2 class="max-w-[22ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          The documentation, and a machine-readable copy of it.
        </h2>
        <p class="mt-6 max-w-[54ch] text-[16px] leading-[1.75] text-ink-2">
          Every route, query parameter, response format, error code, and rate limit is documented.
          Read it yourself, or hand one of the machine-readable descriptions to your tooling.
        </p>
        <div class="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          ${RESOURCE_CARDS}
        </div>
      </div>
    </section>

    <!-- faq: the questions agents and readers actually ask -->
    <section id="faq" class="deferred-section scroll-mt-28 border-t border-line">
      <div class="mx-auto max-w-[1200px] px-6 py-28 sm:px-8 md:py-40">
        <h2 class="max-w-[20ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          Common questions.
        </h2>
        <div class="mt-14 grid gap-x-16 gap-y-10 md:grid-cols-2">
          ${FAQ_ITEMS}
        </div>
      </div>
    </section>

    <!-- action -->
    <section class="deferred-section border-t border-line bg-raised">
      <div class="mx-auto max-w-[1200px] px-6 py-28 text-center sm:px-8 md:py-44">
        <h2 class="mx-auto max-w-[18ch] text-[clamp(2.2rem,5vw,4rem)] leading-[1.05] font-black tracking-tight text-ink">
          Read a post the way your agent does.
        </h2>
        <div class="mt-10 flex flex-wrap items-center justify-center gap-3">
          <a href="#convert" class="btn-primary h-[52px] px-7 text-[15px]">Convert a post</a>
          <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="btn-ghost h-[52px] px-7 text-[15px]">Star on GitHub</a>
        </div>
        <p class="mt-8 text-[14px] text-ink-3">
          MIT-licensed. Fork it, deploy to Vercel, and the same swap works on
          <a href="/docs/self-hosting" class="font-medium text-accent hover:text-accent-deep">your own domain</a>.
        </p>
      </div>
    </section>
  </main>

  ${footerHtml()}
</div>
`
}
