import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!

const EXAMPLE_URL = 'https://x.com/trq212/status/2052809885763747935'

function setupConvertForm(root: HTMLElement) {
  const form = root.querySelector<HTMLFormElement>('[data-convert-form]')
  const input = root.querySelector<HTMLInputElement>('[data-convert-input]')
  if (!form || !input) return

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const raw = input.value.trim()
    if (!raw) return
    const target = `/api/convert?url=${encodeURIComponent(raw)}`
    window.open(target, '_blank', 'noopener,noreferrer')
  })
}

function setupReveal(root: HTMLElement) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const nodes = root.querySelectorAll<HTMLElement>('.reveal')
  if (reduce) {
    nodes.forEach((el) => el.classList.add('is-visible'))
    return
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        }
      }
    },
    { threshold: 0.12, rootMargin: '0px 0px -40px 0px' },
  )

  nodes.forEach((el) => observer.observe(el))
}

app.innerHTML = `
<div class="flex min-h-screen flex-col">
  <header class="site-header sticky top-0 z-40">
    <div class="container-page flex h-16 items-center justify-between">
      <a href="/" class="flex shrink-0 items-center font-semibold tracking-tight">
        <span class="font-mono text-lg">x.md</span>
      </a>
      <nav class="flex items-center gap-6">
        <a class="nav-link font-medium text-ink" href="#docs">Docs</a>
        <a class="nav-link" href="#agents">Agents</a>
        <a class="nav-link" href="/api/convert?url=${encodeURIComponent(EXAMPLE_URL)}" target="_blank" rel="noreferrer">API</a>
      </nav>
    </div>
  </header>

  <main class="flex-1">
    <section class="container-page border-b border-border py-12 lg:py-16">
      <div class="grid min-h-[min(100dvh,720px)] items-center gap-10 lg:grid-cols-2 lg:gap-14">
        <div class="max-w-xl">
          <p class="eyebrow">Self-hosted converter</p>
          <h1 class="text-4xl font-semibold tracking-tight text-ink sm:text-5xl lg:text-[2.75rem] lg:leading-[1.08]">
            X posts as Markdown you can ship anywhere.
          </h1>
          <p class="mt-4 max-w-md text-muted">
            Open stack on Vercel: threads, media, quotes, and X Articles. No converter subscription.
          </p>
          <div class="mt-8 flex flex-wrap gap-3">
            <a class="btn-primary" href="#convert">Convert a post</a>
            <a class="btn-ghost" href="#docs">Read docs</a>
          </div>
        </div>
        <div class="hero-preview">
          <p class="border-b border-[#2a3348] px-4 py-2.5 font-mono text-[11px] text-[#8b95a8]">curl -s -H "Accept: text/markdown" \\</p>
          <pre class="m-0 overflow-auto px-4 py-4 font-mono text-[12px] leading-6 text-[#c8d0e0]">  "/api/convert?url=…"

# trq212 (@trq212)

Source: https://x.com/trq212/status/…
Stats: 2.1K likes · 412 reposts

Full article body when FxTwitter
returns X Article blocks…</pre>
        </div>
      </div>
    </section>

    <section id="convert" class="section-surface py-14">
      <div class="container-page reveal">
        <div class="mx-auto max-w-xl">
          <h2 class="section-title">Convert a post</h2>
          <p class="mt-2 text-muted">Paste any public X status URL. Opens Markdown in a new tab.</p>
          <form data-convert-form class="mt-6 flex flex-col gap-3 sm:flex-row">
            <input
              data-convert-input
              type="url"
              name="url"
              required
              placeholder="https://x.com/handle/status/…"
              value="${EXAMPLE_URL}"
              class="convert-input min-w-0 flex-1"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="submit" class="btn-primary shrink-0">Get Markdown</button>
          </form>
          <p class="mt-4 text-sm text-muted">
            Or call <code>GET /api/convert?url=…</code> with <code>Accept: text/markdown</code>.
          </p>
        </div>
      </div>
    </section>

    <section id="docs" class="container-narrow py-16">
      <div class="reveal mb-12">
        <p class="eyebrow">Documentation</p>
        <h2 class="section-title">Setup and API</h2>
        <p class="mt-3 text-muted">Deploy on Vercel, wire agents, and tune output with query params.</p>
      </div>

      <div class="info-banner reveal mb-12">
        <strong>Provider chain included:</strong> FxTwitter for rich data, X syndication as fallback,
        optional Firecrawl when you set <code>FIRECRAWL_API_KEY</code>.
      </div>

      <article class="reveal mb-16 grid gap-8 border-t border-border pt-12 lg:grid-cols-[1fr_1.1fr] lg:items-start" id="routes">
        <div>
          <p class="eyebrow">HTTP</p>
          <h3 class="section-title text-2xl">Routes</h3>
          <p class="mt-3 text-muted">
            <code>/api/convert</code> takes an encoded status URL. Path-style
            <code>/:handle/status/:id</code> works when rewrites are configured on Vercel.
          </p>
          <p class="mt-4 text-sm text-muted">Responses are Markdown by default (plain text, not JSON).</p>
        </div>
        <pre class="code-block m-0">GET /api/convert?url=https%3A%2F%2Fx.com%2F…
Accept: text/markdown

# handle (@handle)
…</pre>
      </article>

      <article class="reveal mb-16 border-t border-border pt-12" id="agents">
        <p class="eyebrow">Automation</p>
        <h3 class="section-title text-2xl">AI agents</h3>
        <p class="mt-3 max-w-2xl text-muted">Point tools at the convert URL with a full X link. Default path needs no paid tweet API keys.</p>
        <pre class="code-block mt-6">GET /api/convert?url=${encodeURIComponent(EXAMPLE_URL)}
Accept: text/markdown</pre>
        <p class="mt-4 text-sm text-muted">JSON: <code>Accept: application/json</code> includes <code>source</code> (fxtwitter | syndication | firecrawl).</p>
      </article>

      <article class="reveal mb-16 border-t border-border pt-12" id="params">
        <p class="eyebrow">API</p>
        <h3 class="section-title text-2xl">Query params</h3>
        <p class="mt-3 text-muted">Append to <code>/api/convert?url=…</code> or path routes.</p>
        <div class="mt-6 overflow-x-auto rounded-xl border border-border">
          <table class="docs-table m-0 border-0">
            <thead><tr><th>Param</th><th>Default</th><th>Values</th></tr></thead>
            <tbody>
              <tr><td><code>format</code></td><td>markdown</td><td><code>markdown</code>, <code>obsidian</code></td></tr>
              <tr><td><code>thread</code></td><td>off</td><td><code>off</code>, <code>full</code>, <code>2-100</code></td></tr>
              <tr><td><code>userinfo</code></td><td>off</td><td><code>off</code>, <code>author</code>, <code>all</code></td></tr>
              <tr><td><code>url</code></td><td>-</td><td>Encoded X status URL (required on <code>/api/convert</code>)</td></tr>
            </tbody>
          </table>
        </div>
      </article>

      <article class="reveal mb-16 border-t border-border pt-12" id="formats">
        <p class="eyebrow">Output</p>
        <h3 class="section-title text-2xl">Output formats</h3>
        <p class="mt-3 text-muted">Use <code>?format=</code> on any convert URL. Omit for markdown.</p>
        <div class="mt-8 grid gap-4 sm:grid-cols-2">
          <div class="format-tile">
            <strong class="text-lg font-semibold"><code>markdown</code></strong>
            <p class="mt-2 text-sm text-muted">Notes with author, stats, media, quotes, and X Article bodies when available.</p>
          </div>
          <div class="format-tile">
            <strong class="text-lg font-semibold"><code>obsidian</code></strong>
            <p class="mt-2 text-sm text-muted">Vault import with YAML frontmatter and per-post headings.</p>
          </div>
        </div>
        <p class="mt-4 text-sm text-muted">Media uses public X preview URLs in the output file.</p>
      </article>

      <article class="reveal mb-16 border-t border-border pt-12" id="articles">
        <p class="eyebrow">Long form</p>
        <h3 class="section-title text-2xl">X Articles</h3>
        <p class="mt-3 text-muted">Long-form posts use the normal status URL. Article text is pulled from X Article blocks when the primary provider returns them.</p>
        <pre class="code-block mt-6">${EXAMPLE_URL}?format=markdown&amp;thread=full</pre>
      </article>

      <article class="reveal border-t border-border pt-12" id="deploy">
        <p class="eyebrow">Infrastructure</p>
        <h3 class="section-title text-2xl">Deployment</h3>
        <p class="mt-3 text-muted">Bun build, Vercel Hobby, env vars in <code>.env.local</code>. You run the stack, not a hosted SaaS tier.</p>
        <div class="mt-8">
          <div class="provider-row">
            <strong class="text-lg font-semibold">FxTwitter</strong>
            <span class="text-sm text-muted">Primary: threads, media, articles</span>
          </div>
          <div class="provider-row">
            <strong class="text-lg font-semibold">Syndication</strong>
            <span class="text-sm text-muted">X CDN fallback for single posts</span>
          </div>
          <div class="provider-row">
            <strong class="text-lg font-semibold">Firecrawl</strong>
            <span class="text-sm text-muted">Optional scrape if APIs fail</span>
          </div>
        </div>
        <p class="mt-6 text-sm text-muted">Header <code>X-Source</code> reports which provider handled the request.</p>
      </article>
    </section>
  </main>

  <footer class="site-footer">
    <div class="container-page flex flex-col gap-4 py-10 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap gap-5">
        <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="hover:text-ink">GitHub</a>
        <a href="/" class="hover:text-ink">x.md</a>
        <a href="#docs" class="hover:text-ink">Docs</a>
        <a href="/api/convert?url=${encodeURIComponent(EXAMPLE_URL)}" target="_blank" rel="noreferrer" class="hover:text-ink">API</a>
      </div>
      <p>Not affiliated with X Corp.</p>
    </div>
  </footer>
</div>
`

setupConvertForm(app)
setupReveal(app)
