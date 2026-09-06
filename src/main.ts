import './style.css'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { footerHtml, headerHtml, setupLinkPrefetch, setupMobileMenu, setupTheme } from './chrome'

gsap.registerPlugin(ScrollTrigger)

const app = document.querySelector<HTMLDivElement>('#app')!

const EXAMPLE_HANDLE = 'trq212'
const EXAMPLE_ID = '2052809885763747935'
const EXAMPLE_X_URL = `https://x.com/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_PATH = `/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`

const SKILL_CMD = 'bunx skills add pc-style/x-md -g -y'

const HOSTED_HOSTS = new Set([
  'x.pcstyle.dev',
  typeof window !== 'undefined' ? window.location.hostname.replace(/^www\./, '') : '',
])

function statusPathFromUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim())
    const host = parsed.hostname.replace(/^www\./, '')
    if (
      !['x.com', 'twitter.com'].includes(host) &&
      !HOSTED_HOSTS.has(host) &&
      !host.endsWith('.vercel.app')
    ) {
      return null
    }
    const match = parsed.pathname.match(/^\/([^/?#]+)\/status\/(\d+)\/?$/)
    if (!match) return null
    return `/${match[1]}/status/${match[2]}`
  } catch {
    return null
  }
}

function setupConvertForm(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>('[data-convert-form]')
  const input = root.querySelector<HTMLInputElement>('[data-convert-input]')
  if (!form || !input) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const raw = input.value.trim()
    if (!raw) return
    const path = statusPathFromUrl(raw)
    const target = path
      ? `${path}?thread=full`
      : `/api/convert?url=${encodeURIComponent(raw)}&thread=full`
    window.open(target, '_blank', 'noopener,noreferrer')
  })
}

function setupCopyButtons(root: HTMLElement) {
  root.querySelectorAll<HTMLButtonElement>('[data-copy]').forEach((btn) => {
    const original = btn.textContent
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy
      if (!text) return
      try {
        await navigator.clipboard.writeText(text)
        btn.dataset.copied = ''
        btn.textContent = 'Copied'
        window.setTimeout(() => {
          delete btn.dataset.copied
          btn.textContent = original
        }, 1600)
      } catch {
        /* clipboard unavailable; leave the command selectable */
      }
    })
  })
}

function setupAccordion(root: HTMLElement) {
  const items = Array.from(root.querySelectorAll<HTMLElement>('.acc-item'))
  if (!items.length) return
  const open = (item: HTMLElement) => {
    items.forEach((i) => {
      delete i.dataset.open
      i.querySelector<HTMLButtonElement>('.acc-trigger')?.setAttribute('aria-expanded', 'false')
    })
    item.dataset.open = ''
    item.querySelector<HTMLButtonElement>('.acc-trigger')?.setAttribute('aria-expanded', 'true')
  }
  items.forEach((item) => {
    const trigger = item.querySelector<HTMLButtonElement>('.acc-trigger')
    if (!trigger) return
    item.addEventListener('mouseenter', () => open(item))
    trigger.addEventListener('focus', () => open(item))
    trigger.addEventListener('click', () => open(item))
  })
}

function splitWords(el: HTMLElement) {
  const text = (el.textContent ?? '').trim()
  el.innerHTML = text
    .split(/\s+/)
    .map((w) => `<span class="reveal-word">${w}</span>`)
    .join(' ')
}

function setupMotion(root: HTMLElement) {
  const scrubEl = root.querySelector<HTMLElement>('[data-scrub-text]')
  if (scrubEl) splitWords(scrubEl)

  const mm = gsap.matchMedia()

  mm.add('(prefers-reduced-motion: reduce)', () => {
    root
      .querySelectorAll<HTMLElement>('.reveal-word')
      .forEach((w) => (w.style.opacity = '1'))
  })

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    gsap.from('[data-hero-stagger] > *', {
      y: 26,
      opacity: 0,
      duration: 0.9,
      ease: 'power3.out',
      stagger: 0.09,
    })

    gsap.from('[data-hero-card]', {
      y: 48,
      opacity: 0,
      rotate: 6,
      duration: 1.1,
      ease: 'power3.out',
      delay: 0.3,
    })

    const words = gsap.utils.toArray<HTMLElement>('[data-scrub-text] .reveal-word')
    if (words.length) {
      gsap.to(words, {
        opacity: 1,
        stagger: 0.05,
        ease: 'none',
        scrollTrigger: {
          trigger: '[data-scrub-text]',
          start: 'top 80%',
          end: 'center 42%',
          scrub: true,
        },
      })
    }

    gsap.utils.toArray<HTMLElement>('[data-rise-card]').forEach((el, i) => {
      gsap.from(el, {
        y: 36,
        opacity: 0,
        scale: 0.96,
        duration: 0.8,
        delay: (i % 2) * 0.08,
        ease: 'power3.out',
        scrollTrigger: { trigger: el, start: 'top 86%' },
      })
    })
  })

  mm.add('(min-width: 1024px) and (prefers-reduced-motion: no-preference)', () => {
    const section = root.querySelector<HTMLElement>('[data-pin-section]')
    const target = root.querySelector<HTMLElement>('[data-pin-target]')
    if (!section || !target) return
    ScrollTrigger.create({
      trigger: section,
      start: 'top 120px',
      end: () => `+=${Math.max(section.offsetHeight - target.offsetHeight - 160, 0)}`,
      pin: target,
      pinSpacing: false,
      invalidateOnRefresh: true,
    })
  })
}

/* what an agent actually gets back from x.com without a browser */
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
  'No account, no API key',
]

const marqueeTrack = MARQUEE_ITEMS.map(
  (item) => `<span class="flex items-center gap-10"><span>${item}</span><span aria-hidden="true" class="text-accent">·</span></span>`,
).join('')

app.innerHTML = `
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
                <code class="code-chip">GET /api/convert?url=…</code> returns the same Markdown
                with JSON and raw variants. <a href="/docs/posts" class="font-bold text-accent hover:text-accent-deep">API reference →</a>
              </p>
            </div>
          </div>
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

setupConvertForm(app)
setupMobileMenu(app)
setupTheme(app)
setupLinkPrefetch(app)
setupCopyButtons(app)
setupAccordion(app)
setupMotion(app)
