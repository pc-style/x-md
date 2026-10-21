/**
 * The landing page markup.
 *
 * Kept as a pure string builder with no DOM or CSS imports so the Vite config
 * can render it into `index.html` at build time. Agents and crawlers then read
 * the full page from the raw HTML; `main.ts` only wires up behaviour on top.
 */
import { footerHtml, headerHtml, type ChromeData } from './chrome'
import { DAWN_FALLBACK, ECLIPSE_FALLBACK, GLASS_FALLBACK, ORBIT_FALLBACK } from './gradients'

const EXAMPLE_HANDLE = 'trq212'
const EXAMPLE_ID = '2052809885763747935'
const EXAMPLE_X_URL = `https://x.com/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_PATH = `/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`

const SKILL_CMD = 'bunx skills add pc-style/x-md -g -y'

/**
 * Wraps each line of a code pane in its own `.ln` box, numbered in `--i`, so CSS
 * can stream the lines in (the `.stream` rules in style.css). Highlight spans
 * may run across lines, so each line closes and reopens the ones still open.
 * The newlines stay in the text: the pane reads and copies exactly as before,
 * and each line is its own small text block rather than one large one.
 */
function streamLines(html: string): string {
  const open: string[] = []
  return html
    .split('\n')
    .map((line, i) => {
      const reopened = open.join('')
      for (const [tag] of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
        if (tag === '</span>') open.pop()
        else open.push(tag)
      }
      return `<span class="ln" style="--i:${i}">${reopened}${line}${'</span>'.repeat(open.length)}</span>`
    })
    .join('\n')
}

const xComOutput = `<span class="t-dim">&lt;!DOCTYPE html&gt;&lt;html lang="en" dir="ltr"
data-app-env="prod"&gt;&lt;head&gt;&lt;meta charSet="utf-8"
nonce="JCApsPM44mDDnid3Yl…"&gt;&lt;meta
name="viewport" content="width=device-width…</span>

<span class="t-dim">…hundreds of KB of markup,
zero post text…</span>

<span class="t-bad">JavaScript is not available.</span>`

/* real trimmed output from the hosted converter for the example post */
const mdOutput = `<span class="t-key">## Post · 1/11 — Thariq (@trq212)</span>

<span class="t-key">## Using Claude Code: The
   Unreasonable Effectiveness
   of HTML</span>

<span class="t-dim">![cover](https://pbs.twimg.com/…)</span>

Markdown has become the dominant
file format used by agents to
communicate with us…`

const heroCard = `<span class="t-key">## Post · 1/11 — Thariq (@trq212)</span>

<span class="t-key">## Using Claude Code: The Unreasonable
   Effectiveness of HTML</span>

<span class="t-dim">![cover](https://pbs.twimg.com/…)</span>

Markdown has become the dominant file
format used by agents to communicate
with us…`

/** X's action row icons, drawn as plain strokes. */
const POST_ICONS = {
  reply: '<path d="M4 11.5a7 7 0 0 1 7-7h2a7 7 0 1 1 0 14h-1l-4 3v-3.4A7 7 0 0 1 4 11.5Z"/>',
  repost: '<path d="m4 8 3-3 3 3M7 5v9a3 3 0 0 0 3 3h3M20 16l-3 3-3-3M17 19v-9a3 3 0 0 0-3-3h-3"/>',
  like: '<path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z"/>',
  views: '<path d="M5 20V11M10 20V5M15 20v-7M20 20V9"/>',
}

/** The example post's counts as X rounds them, read from the hosted service. */
const POST_ACTIONS = (
  [
    ['reply', '1K'],
    ['repost', '2.2K'],
    ['like', '17K'],
    ['views', '14M'],
  ] as const
)
  .map(
    ([icon, count]) =>
      `<span><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${POST_ICONS[icon]}</svg>${count}</span>`,
  )
  .join('')

/**
 * The example post as a person sees it on x.com: the author, the article's
 * cover and title, the counts. The cover is drawn, not the article's image, so
 * the first paint needs no request. It is a decorative double of the Markdown
 * beside it, so it stays out of the accessibility tree.
 */
const postView = `<div class="post-view" aria-hidden="true">
                <div class="post-head">
                  <span class="post-avatar">T</span>
                  <span class="post-name">Thariq</span>
                  <span class="post-meta">@${EXAMPLE_HANDLE} · May 8</span>
                </div>
                <div class="post-article">
                  <div class="post-cover">
                    <span class="post-cover-kicker"></span>
                    <span class="post-cover-line"></span>
                    <span class="post-cover-line post-cover-line-short"></span>
                    <span class="post-cover-page"></span>
                    <span class="post-cover-page"></span>
                  </div>
                  <p class="post-title">Using Claude Code: The Unreasonable Effectiveness of HTML</p>
                </div>
                <div class="post-actions">${POST_ACTIONS}</div>
              </div>`

/**
 * The hero's demo: the product's one action. The card opens on the post as
 * x.com renders it, "mdfrom" arrives in front of the host, the tag flips to
 * `text/markdown`, and a scan line passes down the card, leaving Markdown
 * behind it. The markup is the finished state, which is what readers without
 * JavaScript or with reduced motion get; the load animation is CSS keyed off
 * `html[data-motion]` (set in index.html), so it starts with the first paint.
 * `main.ts` mirrors the converter's URL into `data-card-path`, and with a mouse
 * the scan line follows the pointer (`pointer.ts`).
 */
const heroDemo = `<div class="float-card hero-demo">
            <div class="float-card-bar">
              <span class="card-url"><span class="card-url-prefix">mdfrom</span><span class="card-url-rest">x.com<span data-card-path>${EXAMPLE_PATH}</span></span></span>
              <span class="card-tag"><span class="pane-tag pane-tag-bad card-tag-from" aria-hidden="true">text/html</span><span class="pane-tag pane-tag-good card-tag-to">text/markdown</span></span>
            </div>
            <div class="card-body">
              ${postView}
              <pre class="stream">${streamLines(heroCard)}</pre>
              <span class="card-scan" aria-hidden="true"></span>
            </div>
          </div>`

type Excerpt = { id: string; label: string; title: string; blurb: string; request: string; markdown: string }

/**
 * "What comes through", one real response per kind. Each excerpt is trimmed
 * output of the hosted service for the request shown above it (`…` marks a
 * cut); nothing here is output the API does not produce.
 */
const EXCERPTS: Excerpt[] = [
  {
    id: 'threads',
    label: 'Threads',
    title: 'Threads',
    blurb: `The full reply chain comes back by default, numbered in order.
              Add <code class="code-chip">?thread=off</code> when you only want the one post.`,
    request: '/trq212/status/2104983034152063339',
    markdown: `<span class="t-key">## Post · 1/15 — Thariq (@trq212)</span>

I was on the latent space podcast with Swyx and Vibhu!
…
<span class="t-dim">Source: https://x.com/trq212/status/2104983034152063339
---</span>

<span class="t-key">## Thread · 2/15 — Thariq (@trq212)</span>

2/ Basically all evals are saturated if you look at the transcripts, the models almost always see the correct solution and barely miss it.
…
<span class="t-dim">---</span>

<span class="t-key">## Thread · 3/15 — Thariq (@trq212)</span>

3/ The hugging face incident - what happened and why it was such a big update to me
…`,
  },
  {
    id: 'media',
    label: 'Media',
    title: 'Media',
    blurb: 'Images and video survive as Markdown links instead of disappearing into a player.',
    request: '/trq212/status/2107192901537329354?thread=off',
    markdown: `<span class="t-key">## Post · 1/1 — Thariq (@trq212)</span>

I've been working on a skill that makes better HTML plans in Claude Code.

It uses simple language, shows code snippets, surfaces questions &amp; makes mockups. …

<span class="t-dim">&gt;</span> [video](https://video.twimg.com/amplify_video/…/Z9oP5h3b6Si4JJSh.mp4)
<span class="t-dim">&gt;</span> ![video thumbnail](https://pbs.twimg.com/amplify_video_thumb/…/uRUNrBppYBlJb6eh.jpg)
<span class="t-dim">Source: https://x.com/trq212/status/2107192901537329354</span>`,
  },
  {
    id: 'quotes',
    label: 'Quote posts',
    title: 'Quote posts',
    blurb: 'Quoted posts are nested inline where they appear, not dropped or reduced to a bare link.',
    request: '/trq212/status/2105849729297055792?thread=off',
    markdown: `<span class="t-key">## Post · 1/1 — Thariq (@trq212)</span>

This is a personal side project I've been working on! Here's the original post: …

<span class="t-dim">&gt;</span> **Quoted post**
<span class="t-dim">&gt;</span>
<span class="t-dim">&gt;</span> **Thariq** @trq212
<span class="t-dim">&gt;</span> As a personal side project, I've been prototyping a video game.
<span class="t-dim">&gt;</span> …
<span class="t-dim">&gt;</span> [video](https://video.twimg.com/amplify_video/…/w_0z92VuuMU0fxgT.mp4)
<span class="t-dim">&gt; Source: https://x.com/trq212/status/2105333496768319969</span>

<span class="t-dim">Source: https://x.com/trq212/status/2105849729297055792</span>`,
  },
  {
    id: 'articles',
    label: 'X Articles',
    title: 'X Articles',
    blurb: 'Long-form articles convert with their full body — headings, lists, and embedded posts included.',
    request: `${EXAMPLE_PATH}?thread=off`,
    markdown: `<span class="t-key">## Post · 1/1 — Thariq (@trq212)</span>

<span class="t-key">## Using Claude Code: The Unreasonable Effectiveness of HTML</span>

![cover](https://pbs.twimg.com/media/HHz_ftzaIAAwkQs.jpg)

This is now also on the Claude Blog.

Markdown has become the dominant file format used by agents to communicate with us. …

<span class="t-key"># Why HTML?</span>

<span class="t-key">## Information Density</span>

HTML can convey much richer information compared to markdown. …`,
  },
  {
    id: 'obsidian',
    label: 'Obsidian',
    title: 'Obsidian frontmatter',
    blurb: `<code class="code-chip">?format=obsidian</code> adds YAML frontmatter with author,
              date, and source URL, ready for your vault.`,
    request: `${EXAMPLE_PATH}?format=obsidian&amp;thread=off`,
    markdown: `<span class="t-dim">---</span>
<span class="t-key">source:</span> https://x.com/trq212/status/2052809885763747935
<span class="t-key">author:</span> Thariq
<span class="t-key">author_handle:</span> trq212
<span class="t-key">published:</span> Fri May 08 17:56:30 +0000 2026
<span class="t-key">tags:</span> [twitter, x, trq212]
<span class="t-dim">---</span>

<span class="t-key">## Post · 1/1 — Thariq (@trq212)</span>

<span class="t-key">## Using Claude Code: The Unreasonable Effectiveness of HTML</span>
…`,
  },
]

/**
 * Rendered stacked: with JavaScript off every kind reads one after another.
 * `tabs.ts` unhides the tablist and turns the stack into tab panels.
 */
const EXCERPT_TABS = EXCERPTS.map(
  (item, i) =>
    `<button type="button" role="tab" id="tab-${item.id}" aria-controls="panel-${item.id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" class="tab">${item.label}</button>`,
).join('\n            ')

const EXCERPT_PANELS = EXCERPTS.map(
  (item) => `<div id="panel-${item.id}" class="tab-panel spot">
            <div class="tab-copy">
              <h3 class="tab-title text-[21px] font-bold text-ink">${item.title}</h3>
              <p class="mt-3 max-w-[44ch] text-[15.5px] leading-relaxed text-ink-2">
              ${item.blurb}
              </p>
            </div>
            <div class="code-pane">
              <p class="code-pane-bar"><span class="t-dim">$ curl</span> 'mdfromx.com${item.request}'</p>
              <pre>${item.markdown}</pre>
            </div>
          </div>`,
).join('\n          ')

/**
 * A box of live sky: it paints the gradient's CSS fallback itself, so the light
 * is there with JavaScript off, and the canvas fades in over it once
 * `gradient-canvas.ts` has rendered a frame. A sky without a fallback is extra
 * light that the band reads the same without.
 */
const sky = (className: string, gradient: string, fallback?: string) => `<div class="${className}"${fallback ? ` style="background: ${fallback}"` : ''} aria-hidden="true">
        <canvas class="gradient-canvas" data-gradient="${gradient}"></canvas>
      </div>`

/**
 * An always-dark band with light low in it, under the copy. The hero's is a
 * planet's lit edge with aurora hanging over it; the closing band's is dawn.
 */
const skyBand = (classes: string, skies: string, content: string) => `<section class="night sky-band ${classes}">
      ${skies}
      ${content}
    </section>`

/**
 * The headline's "markdown" in live chrome. The word keeps its static fill
 * (and stays the headline's text) until the canvas has painted, and the canvas
 * shows only through its letters where the browser can mask to text.
 */
const headlineMark = `<span class="chrome-word"><canvas class="gradient-canvas chrome-word-fill" data-gradient="mark" aria-hidden="true"></canvas><span>markdown</span></span>`

/**
 * The closing band ends on the product's name at full size, at dawn.
 * One box per letter of "mdfrom", so `motion.ts` can type them in front of the
 * host, the way the product is used. The markup is the finished name; the
 * canvas fills the letters with live chrome where the browser can mask to text.
 */
const hostMark = `<p class="host-mark" aria-hidden="true"><span class="host-mark-prefix"><canvas class="gradient-canvas host-mark-fill" data-gradient="name"></canvas>${[...'mdfrom']
  .map((letter, i) => `<span style="--i:${i}">${letter}</span>`)
  .join('')}</span><span class="host-mark-caret"></span><span class="host-mark-host">x.com</span></p>`

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
  (item) => `<a href="${item.href}" class="res-card spot"${item.external ? ' target="_blank" rel="noreferrer"' : ''}>
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
      'Three ways: tell the agent in its prompt to swap x.com for mdfromx.com, install the browse-x skill, or call the documented HTTP API described at /docs, /openapi.json, and /mcp.',
  },
]

/**
 * Query parameters, the Accept header and site paths render as code chips. The
 * visible text stays identical to `FAQ`, so the JSON-LD copy still matches it.
 */
function faqAnswerHtml(answer: string): string {
  return answer.replace(
    /\?[a-z]+=[a-z]+|Accept: application\/json|(?<=\s)\/(?:docs|openapi\.json|mcp)\b/g,
    (token) => `<code class="code-chip">${token}</code>`,
  )
}

const FAQ_ITEMS = FAQ.map(
  (item) => `<div>
            <h3 class="text-[18px] leading-snug font-bold text-ink">${item.question}</h3>
            <p class="mt-3 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-2">${faqAnswerHtml(item.answer)}</p>
          </div>`,
).join('\n          ')

export function landingHtml(chrome: ChromeData = {}): string {
  return `
<div class="x-root w-full max-w-full overflow-x-clip">
  <a href="#convert" class="skip-link">Skip to converter</a>
  ${headerHtml({ page: 'landing', ...chrome })}

  <main id="top" class="w-full max-w-full overflow-x-clip">

    <!-- hero: the page opens over a planet's lit edge, under aurora -->
    ${skyBand(
      'sky-band-hero',
      `${sky('orbit-sky', 'orbit', ORBIT_FALLBACK)}
      ${sky('aurora-sky', 'aurora')}`,
      `<div class="relative mx-auto grid max-w-[1200px] items-start gap-12 px-6 pt-12 pb-(--band-pad) sm:px-8 sm:pt-20 lg:grid-cols-12 lg:gap-10 lg:pt-24">
        <div class="lg:col-span-7">
          <h1 class="hero-h max-w-[15ch] text-[clamp(2.75rem,5.4vw,4.6rem)] leading-[1.02] font-black text-ink">
            Tweets are just ${headlineMark} now.
          </h1>
          <p class="mt-6 max-w-[46ch] text-[16px] leading-[1.7] text-ink-2 sm:text-[17.5px]">
            Treat them that way. Swap <code class="code-chip">x.com</code> for
            <code class="code-chip">mdfromx.com</code> in any public post URL and the
            post, its thread, or the full article comes back as Markdown your agent can read.
          </p>

          <div id="convert" class="mt-9 max-w-[600px] scroll-mt-28">
            <form data-convert-form data-beam class="convert-shell">
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
                aria-describedby="convert-note"
                class="convert-input"
              />
              <button type="submit" class="btn-primary h-12 shrink-0 px-6 text-[14.5px]">
                Get Markdown
              </button>
            </form>
            <p id="convert-note" class="sr-only">
              Opens the converted post in a new tab — the same result as swapping the host by hand.
            </p>
            <p class="proof-line">Open source · Free · No account</p>
          </div>
        </div>

        <div class="lg:col-span-5 lg:pt-2">
          ${heroDemo}
        </div>
      </div>`,
    )}

    <!-- interest: gapless bento, before / after -->
    <section id="how" class="scroll-mt-28">
      <div class="section-pad mx-auto max-w-[1200px]">
        <h2 class="max-w-[22ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          You see the same post either way. Your agent doesn't.
        </h2>
        <div class="bento mt-12" data-spotlight>
          <article class="bento-card bento-a bento-dark spot">
            <div class="flex items-center justify-between gap-3">
              <p class="min-w-0 truncate font-mono text-[12px]" style="color: var(--color-code-dim)">$ curl x.com${EXAMPLE_PATH}</p>
              <span class="pane-tag pane-tag-bad shrink-0">no content</span>
            </div>
            <pre data-stream-view data-rain class="stream mt-6 overflow-x-auto font-mono text-[12.5px] leading-[1.8] whitespace-pre max-sm:whitespace-pre-wrap max-sm:[overflow-wrap:anywhere]" style="color: var(--color-code-ink); --stagger: 35ms">${streamLines(xComOutput)}</pre>
          </article>
          <article class="bento-card bento-b bento-dark spot">
            <div class="flex items-center justify-between gap-3">
              <p class="min-w-0 truncate font-mono text-[12px]" style="color: var(--color-code-dim)">$ curl mdfromx.com${EXAMPLE_PATH}</p>
              <span class="pane-tag pane-tag-good shrink-0">markdown</span>
            </div>
            <pre data-stream-view class="stream mt-6 overflow-x-auto font-mono text-[12.5px] leading-[1.8] whitespace-pre max-sm:whitespace-pre-wrap max-sm:[overflow-wrap:anywhere]" style="color: var(--color-code-ink); --stagger: 65ms">${streamLines(mdOutput)}</pre>
          </article>
          <article class="bento-card bento-c bento-tint spot">
            <h3 class="text-[19px] font-bold text-ink">One host swap, nothing else</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              Same path, same status ID. That's a real post converted live:
              <a href="${EXAMPLE_PATH}?thread=full" target="_blank" rel="noreferrer" class="font-bold text-accent hover:text-accent-deep">see the full conversion →</a>
            </p>
          </article>
          <article class="bento-card bento-d spot">
            <h3 class="text-[19px] font-bold text-ink">Pipe it anywhere</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              The response is plain <code class="code-chip">text/markdown</code>, so
              <code class="code-chip">curl … &gt; post.md</code> drops a tweet straight into your vault.
            </p>
          </article>
        </div>
      </div>
    </section>

    <!-- desire: scrubbing statement, over an eclipse rising below it -->
    <section class="night eclipse-band">
      ${sky('eclipse-sky', 'eclipse', ECLIPSE_FALLBACK)}
      <div class="section-pad relative mx-auto max-w-[1000px]">
        <p data-scrub-text class="text-[clamp(1.6rem,3.4vw,2.7rem)] leading-[1.35] font-bold tracking-tight text-ink">
          Your notes, your scripts, and your agents all speak Markdown. X speaks JavaScript. x.md is the translation layer: keep the URL, change the host, read the post.
        </p>
      </div>
    </section>

    <!-- desire: what comes through, one real response per kind -->
    <section>
      <div class="section-pad mx-auto max-w-[1200px]">
        <h2 class="max-w-[16ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          Nothing important gets dropped.
        </h2>
        <p class="mt-5 max-w-[52ch] text-[15.5px] leading-relaxed text-ink-3">
          Conversion keeps the parts that matter when you're saving a post for later — or feeding it to a model.
        </p>
        <div class="mt-12" data-tabs>
          <div role="tablist" aria-label="What comes through" class="tablist" hidden>
            ${EXCERPT_TABS}
          </div>
          <div class="tab-panels" data-spotlight>
          ${EXCERPT_PANELS}
          </div>
        </div>
      </div>
    </section>

    <!-- agents: three ways in, all visible -->
    <section id="agents" class="deferred-section scroll-mt-28">
      <div class="section-pad mx-auto max-w-[1200px]">
        <h2 class="max-w-[20ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          Three ways to point an agent at it.
        </h2>
        <div class="mt-12 grid gap-4 lg:grid-cols-[1fr_1.4fr_1fr]" data-spotlight>
          <article class="way-card spot">
            <p class="way-label">for any agent</p>
            <h3 class="mt-3 text-[20px] font-bold text-ink">Say it in the prompt</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              One line is enough. Every agent that can fetch a URL now reads tweets.
            </p>
            <div class="mt-auto pt-6">
              <p class="way-quote">"To read an X post, swap x.com for mdfromx.com."</p>
            </div>
          </article>
          <article class="way-card way-card-accent night spot">
            ${sky('card-sky', 'glass', GLASS_FALLBACK)}
            <p class="way-label">for skills-aware agents</p>
            <h3 class="mt-3 text-[20px] font-bold text-ink">Install the skill</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              One command teaches Amp, Claude Code, and friends the host swap permanently.
            </p>
            <div class="mt-auto pt-6">
              <div class="cmd-row">
                <code><span class="t-dim mr-2 select-none">$</span>${SKILL_CMD}</code>
                <button type="button" class="copy-btn" data-copy="${SKILL_CMD}">Copy</button>
              </div>
            </div>
          </article>
          <article class="way-card spot">
            <p class="way-label">for scripts</p>
            <h3 class="mt-3 text-[20px] font-bold text-ink">Call the API</h3>
            <p class="mt-3 text-[14.5px] leading-relaxed text-ink-2">
              The same Markdown, with JSON and raw variants. Every route, parameter, and limit is
              written down in the
              <a href="/docs" class="font-bold text-accent hover:text-accent-deep">API documentation</a>
              and described again in
              <a href="/openapi.json" class="font-bold text-accent hover:text-accent-deep">OpenAPI</a>.
            </p>
            <p class="mt-auto pt-6"><code class="code-chip">GET /api/v1/posts?url=…</code></p>
          </article>
        </div>
      </div>
    </section>

    <!-- documentation: crawlable links to every published surface -->
    <section id="resources" class="deferred-section scroll-mt-28">
      <div class="section-pad mx-auto max-w-[1200px]">
        <h2 class="max-w-[22ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          The documentation, and a machine-readable copy of it.
        </h2>
        <p class="mt-6 max-w-[54ch] text-[16px] leading-[1.75] text-ink-2">
          Every route, query parameter, response format, error code, and rate limit is documented.
          Read it yourself, or hand one of the machine-readable descriptions to your tooling.
        </p>
        <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-spotlight>
          ${RESOURCE_CARDS}
        </div>
      </div>
    </section>

    <!-- faq: the questions agents and readers actually ask -->
    <section id="faq" class="deferred-section scroll-mt-28">
      <div class="section-pad mx-auto max-w-[1200px]">
        <h2 class="max-w-[20ch] text-[clamp(1.9rem,3.6vw,3rem)] leading-[1.1] font-black tracking-tight text-ink">
          Common questions.
        </h2>
        <div class="mt-12 grid gap-x-16 gap-y-10 md:grid-cols-2">
          ${FAQ_ITEMS}
        </div>
      </div>
    </section>

    <!-- action: the page closes at dawn, on the name -->
    ${skyBand(
      'sky-band-closing deferred-section',
      sky('dawn-sky', 'dawn', DAWN_FALLBACK),
      `<div class="relative mx-auto max-w-[1200px] px-6 pt-24 pb-(--band-pad) text-center sm:px-8 md:pt-32">
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
        ${hostMark}
      </div>`,
    )}
  </main>

  ${footerHtml()}
</div>
`
}
