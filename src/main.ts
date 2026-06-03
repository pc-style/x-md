import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!

const EXAMPLE_HANDLE = 'trq212'
const EXAMPLE_ID = '2052809885763747935'
const EXAMPLE_X_URL = `https://x.com/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_HOSTED_URL = `https://x.pcstyle.dev/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_PATH = `/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`

function statusPathFromUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim())
    const host = parsed.hostname.replace(/^www\./, '')
    if (!['x.com', 'twitter.com', 'x.pcstyle.dev'].includes(host) && !host.endsWith('.vercel.app')) {
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
    if (!path) return
    window.open(path, '_blank', 'noopener,noreferrer')
  })
}

app.innerHTML = `
<div class="x-root w-full overflow-hidden">
  <header class="relative w-full border-b border-white/[0.08]">
    <nav aria-label="Primary" class="mx-auto flex h-[73px] max-w-[1200px] items-center justify-between px-8">
      <a href="#top" class="font-mono text-[17px] font-medium tracking-tight text-[#f7f8f8]">x.md</a>
      <div class="hidden items-center gap-1 md:flex">
        <a href="#hosted" class="nav-link h-8 px-3">Hosted</a>
        <a href="#docs" class="nav-link h-8 px-3">Docs</a>
        <a href="#agents" class="nav-link h-8 px-3">Agents</a>
        <a href="#routes" class="nav-link h-8 px-3">API</a>
      </div>
      <div class="flex items-center gap-3">
        <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="nav-link hidden h-8 px-3 sm:flex">GitHub</a>
        <a href="#convert" class="btn-primary flex h-8 items-center rounded-full px-3.5 text-[13px]">Convert a post</a>
      </div>
    </nav>
  </header>

  <main id="top">
    <section class="mx-auto max-w-[1200px] px-8 pt-[88px] pb-[120px]">
      <div class="grid items-center gap-14 lg:grid-cols-2">
        <div class="max-w-[520px]">
          <p class="eyebrow eyebrow-accent mb-5">Open-source converter</p>
          <h1 class="hero-h text-[clamp(40px,5vw,64px)] font-medium leading-[1.02] text-[#f7f8f8]">
            X posts as Markdown you can ship anywhere.
          </h1>
          <p class="mt-6 max-w-[440px] text-[17px] leading-[1.6] text-[#8a8f98]">
            Use the live site at <code class="code-chip">x.pcstyle.dev</code> or deploy your own on Vercel. Threads, media, quotes, and X Articles — no paid X API keys on the default path.
          </p>
          <div class="mt-9 flex flex-wrap gap-3">
            <a href="#convert" class="btn-primary flex h-10 items-center rounded-full px-3.5 text-[13px]">Convert a post</a>
            <a href="#hosted" class="btn-ghost flex h-10 items-center rounded-full px-3.5 text-[13px]">How hosted works</a>
          </div>
        </div>

        <div class="hero-terminal">
          <div class="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <span class="h-3 w-3 rounded-full bg-[#232326]"></span>
            <span class="h-3 w-3 rounded-full bg-[#232326]"></span>
            <span class="h-3 w-3 rounded-full bg-[#232326]"></span>
            <span class="ml-2 font-mono text-[11px] text-[#62666d]">swap the host</span>
          </div>
          <pre class="m-0 overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-[1.7] text-[#d0d6e0]"><span class="text-[#62666d]"># x.com post</span>
<span class="text-[#8a8f98]">https://x.com/${EXAMPLE_HANDLE}/status/…</span>

<span class="text-[#62666d]"># same path on x.md → Markdown in the browser</span>
<span class="text-[#7170ff]">${EXAMPLE_HOSTED_URL}</span>

<span class="text-[#62666d]"># trq212 (@trq212)</span>

<span class="text-[#8a8f98]">Source:</span> https://x.com/${EXAMPLE_HANDLE}/status/…
<span class="text-[#8a8f98]">Stats:</span> 2.1K likes · 412 reposts</pre>
        </div>
      </div>
    </section>

    <section id="convert" class="mx-auto max-w-[1200px] px-8 pb-[120px]">
      <div class="convert-card mx-auto max-w-[620px]">
        <p class="eyebrow eyebrow-accent mb-3">Try it</p>
        <h2 class="text-[28px] font-medium leading-tight text-[#f7f8f8]">Convert a post</h2>
        <p class="mt-2 text-[16px] text-[#8a8f98]">Paste any public X status URL. Opens Markdown at the same path on this site.</p>
        <form data-convert-form class="mt-7 flex flex-col gap-3 sm:flex-row">
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
          <button type="submit" class="btn-primary flex h-[42px] shrink-0 items-center justify-center rounded-full px-4 text-[13px]">Get Markdown</button>
        </form>
        <p class="mt-4 text-[14px] text-[#8a8f98]">
          Opens <code class="code-chip">${EXAMPLE_PATH}</code> here — the same trick as swapping <code class="code-chip">x.com</code> → <code class="code-chip">x.pcstyle.dev</code> in the link.
        </p>
      </div>
    </section>

    <section id="docs" class="mx-auto max-w-[920px] px-8 pb-[120px]">
      <div class="mb-14 max-w-[560px]">
        <p class="eyebrow eyebrow-accent mb-3">Documentation</p>
        <h2 class="text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-[#f7f8f8]">Setup and API</h2>
        <p class="mt-4 text-[17px] leading-[1.6] text-[#8a8f98]">Use the hosted converter as-is, or fork and deploy your own stack on Vercel.</p>
      </div>

      <article id="hosted" class="mb-16">
        <p class="eyebrow eyebrow-muted mb-3">Hosted</p>
        <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">How x.pcstyle.dev works</h3>
        <p class="mt-3 max-w-[640px] text-[16px] leading-relaxed text-[#8a8f98]">
          The public deploy is a read-only converter. Take any X status link and replace the host — keep the path identical:
        </p>
        <pre class="code-block mt-6">https://x.com/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}
        ↓
${EXAMPLE_HOSTED_URL}</pre>
        <p class="mt-4 text-[16px] leading-relaxed text-[#8a8f98]">
          Append query params the same way: <code class="code-chip">?format=obsidian</code>, <code class="code-chip">?thread=full</code>, <code class="code-chip">?userinfo=author</code>.
        </p>
        <div class="mt-8 grid gap-4 sm:grid-cols-2">
          <div class="compare-tile">
            <h4>Hosted (x.pcstyle.dev)</h4>
            <ul class="mt-3 space-y-2 text-[14px] leading-relaxed text-[#8a8f98]">
              <li>FxTwitter primary, X syndication fallback</li>
              <li>Cached responses (about 1 hour by default)</li>
              <li>CORS open on <code class="code-chip">/api/*</code> for agents</li>
              <li><strong class="text-[#f7f8f8]">No Firecrawl</strong> — not configured on production</li>
            </ul>
          </div>
          <div class="compare-tile">
            <h4>Self-host (your Vercel project)</h4>
            <ul class="mt-3 space-y-2 text-[14px] leading-relaxed text-[#8a8f98]">
              <li>Same FxTwitter + syndication chain</li>
              <li>Optional <code class="code-chip">FIRECRAWL_API_KEY</code> scrape fallback</li>
              <li>Your cache TTL and env vars</li>
              <li>Same URL swap on your domain</li>
            </ul>
          </div>
        </div>
        <p class="mt-4 text-[14px] text-[#62666d]">
          <code class="code-chip">X-Source</code> is <code class="code-chip">fxtwitter</code> or <code class="code-chip">syndication</code> on the hosted site. Self-host only adds <code class="code-chip">firecrawl</code> when the key is set.
        </p>
      </article>

      <div class="info-banner mb-16">
        <strong class="font-medium text-[#f7f8f8]">Provider chain:</strong> FxTwitter for rich data, X syndication as fallback.
        <span class="text-[#8a8f98]"> Firecrawl is </span>
        <strong class="font-medium text-[#f7f8f8]">self-host only</strong>
        <span class="text-[#8a8f98]"> — set </span>
        <code class="code-chip text-[#f7f8f8]">FIRECRAWL_API_KEY</code>
        <span class="text-[#8a8f98]"> on your own deploy; it is not enabled on x.pcstyle.dev.</span>
      </div>

      <article id="routes" class="mb-16 grid gap-8 border-t border-[#23252a] pt-12 lg:grid-cols-[1fr_1.1fr] lg:items-start">
        <div>
          <p class="eyebrow eyebrow-muted mb-3">HTTP</p>
          <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">Routes</h3>
          <p class="mt-3 text-[16px] leading-relaxed text-[#8a8f98]">
            Path-style is the usual way: <code class="code-chip">/:handle/status/:id</code> returns Markdown in the browser. Vercel rewrites map it to the converter.
          </p>
          <p class="mt-4 text-[16px] leading-relaxed text-[#8a8f98]">
            <code class="code-chip">/api/convert?url=…</code> still works when you need an encoded URL (agents, curl, tools that only accept query strings).
          </p>
          <p class="mt-4 text-[14px] text-[#62666d]">Responses are Markdown by default (plain text, not JSON).</p>
        </div>
        <pre class="code-block">GET ${EXAMPLE_PATH}
Accept: text/markdown

# ${EXAMPLE_HANDLE} (@${EXAMPLE_HANDLE})
…</pre>
      </article>

      <article id="agents" class="mb-16 border-t border-[#23252a] pt-12">
        <p class="eyebrow eyebrow-muted mb-3">Automation</p>
        <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">AI agents</h3>
        <p class="mt-3 max-w-[640px] text-[16px] leading-relaxed text-[#8a8f98]">
          Easiest path: swap the host and fetch Markdown. For Cursor and other agents, install the bundled skills with the <a href="https://skills.sh/" class="text-[#7170ff] hover:text-[#828fff]" target="_blank" rel="noreferrer">skills</a> CLI:
        </p>
        <pre class="code-block mt-6"># list skills in this repo
npx skills add pc-style/x-md --list

# global install (recommended — works across projects)
npx skills add pc-style/x-md -g -y \\
  --skill read-x-links-vercel --skill read-x-links-local

# or project-only, from an x-md checkout
npx skills add pc-style/x-md -y \\
  --skill read-x-links-vercel --skill read-x-links-local</pre>
        <div class="mt-8 grid gap-4 lg:grid-cols-2">
          <div class="compare-tile">
            <h4>read-x-links-vercel</h4>
            <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Hosted API only — no local repo or Bun required. Uses FxTwitter + syndication on x.pcstyle.dev (no Firecrawl).</p>
            <pre class="code-block mt-4 text-[12px]"># after npx skills add …
~/.agents/skills/read-x-links-vercel/scripts/read-x.sh \\
  "${EXAMPLE_X_URL}"

# or from this repo without installing:
./skills/read-x-links-vercel/scripts/read-x.sh \\
  "${EXAMPLE_X_URL}"</pre>
          </div>
          <div class="compare-tile">
            <h4>read-x-links-local</h4>
            <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Full local CLI — threads, Obsidian output, optional Firecrawl when you set <code class="code-chip">FIRECRAWL_API_KEY</code>.</p>
            <pre class="code-block mt-4 text-[12px]">cd x-md && bun install
cp .env.local.example .env.local   # optional

bun run read-x -- "${EXAMPLE_X_URL}" --thread full

# or the installed skill script (needs X_MD_ROOT):
~/.agents/skills/read-x-links-local/scripts/read-x.sh \\
  "${EXAMPLE_X_URL}" --thread full</pre>
          </div>
        </div>
        <p class="mt-6 text-[16px] leading-relaxed text-[#8a8f98]">
          Raw HTTP without skills — path-style first, query-style when you need an encoded URL:
        </p>
        <pre class="code-block mt-4"># path-style (preferred)
curl -sS -H "Accept: text/markdown" \\
  "${EXAMPLE_HOSTED_URL}?thread=full"

# query-style (tools that only accept ?url=)
curl -sS -G "https://x.pcstyle.dev/api/convert" \\
  --data-urlencode "url=${EXAMPLE_X_URL}" \\
  -H "Accept: text/markdown"</pre>
        <p class="mt-4 text-[14px] text-[#62666d]">
          JSON: <code class="code-chip">Accept: application/json</code> includes <code class="code-chip">source</code> (<code class="code-chip">fxtwitter</code> | <code class="code-chip">syndication</code> on hosted; <code class="code-chip">firecrawl</code> only on self-host with the key set).
        </p>
      </article>

      <article id="params" class="mb-16 border-t border-[#23252a] pt-12">
        <p class="eyebrow eyebrow-muted mb-3">API</p>
        <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">Query params</h3>
        <p class="mt-3 text-[16px] leading-relaxed text-[#8a8f98]">
          Append to path URLs or <code class="code-chip">/api/convert?url=…</code>.
        </p>
        <div class="mt-6 overflow-x-auto rounded-xl border border-[#23252a]">
          <table class="docs-table">
            <thead>
              <tr>
                <th>Param</th>
                <th>Default</th>
                <th>Values</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><code>format</code></td>
                <td>markdown</td>
                <td class="font-mono text-[12px]">markdown, obsidian</td>
              </tr>
              <tr>
                <td><code>thread</code></td>
                <td>off</td>
                <td class="font-mono text-[12px]">off, full, 2-100</td>
              </tr>
              <tr>
                <td><code>userinfo</code></td>
                <td>off</td>
                <td class="font-mono text-[12px]">off, author, all</td>
              </tr>
              <tr>
                <td><code>url</code></td>
                <td>—</td>
                <td class="text-[#d0d6e0]">Encoded X status URL (<code class="code-chip">/api/convert</code> only; path routes omit this)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>

      <article id="formats" class="mb-16 border-t border-[#23252a] pt-12">
        <p class="eyebrow eyebrow-muted mb-3">Output</p>
        <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">Output formats</h3>
        <p class="mt-3 text-[16px] leading-relaxed text-[#8a8f98]">
          Use <code class="code-chip">?format=</code> on any convert URL. Omit for markdown.
        </p>
        <div class="mt-7 grid gap-4 sm:grid-cols-2">
          <div class="format-tile">
            <strong class="font-mono text-[15px] font-medium text-[#55ccff]">markdown</strong>
            <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Notes with author, stats, media, quotes, and X Article bodies when available.</p>
          </div>
          <div class="format-tile">
            <strong class="font-mono text-[15px] font-medium text-[#55ccff]">obsidian</strong>
            <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Vault import with YAML frontmatter and per-post headings.</p>
          </div>
        </div>
        <p class="mt-4 text-[14px] text-[#62666d]">Media uses public X preview URLs in the output file.</p>
      </article>

      <article id="articles" class="mb-16 border-t border-[#23252a] pt-12">
        <p class="eyebrow eyebrow-muted mb-3">Long form</p>
        <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">X Articles</h3>
        <p class="mt-3 max-w-[640px] text-[16px] leading-relaxed text-[#8a8f98]">
          Long-form posts use the normal status URL. Article text is pulled from X Article blocks when FxTwitter returns them (syndication fallback may omit article body).
        </p>
        <pre class="code-block mt-6">${EXAMPLE_HOSTED_URL}?format=markdown&amp;thread=full</pre>
      </article>

      <article id="deploy" class="border-t border-[#23252a] pt-12">
        <p class="eyebrow eyebrow-muted mb-3">Infrastructure</p>
        <h3 class="text-[24px] font-semibold leading-tight text-[#f7f8f8]">Self-host on Vercel</h3>
        <p class="mt-3 max-w-[640px] text-[16px] leading-relaxed text-[#8a8f98]">
          Fork the repo, deploy to Vercel, and optionally add env vars in <code class="code-chip">.env.local</code>. Your instance gets the same path-style URLs on your domain.
        </p>
        <div class="mt-7 space-y-0">
          <div class="provider-row">
            <strong class="text-[17px] font-medium text-[#f7f8f8]">FxTwitter</strong>
            <span class="text-[14px] text-[#8a8f98]">Primary — threads, media, articles (hosted + self-host)</span>
          </div>
          <div class="provider-row">
            <strong class="text-[17px] font-medium text-[#f7f8f8]">Syndication</strong>
            <span class="text-[14px] text-[#8a8f98]">X CDN fallback for single posts (hosted + self-host)</span>
          </div>
          <div class="provider-row">
            <strong class="text-[17px] font-medium text-[#f7f8f8]">Firecrawl</strong>
            <span class="text-[14px] text-[#8a8f98]">Self-host only — optional scrape when you set <code class="code-chip">FIRECRAWL_API_KEY</code></span>
          </div>
        </div>
        <div class="info-banner-muted mt-6">
          The live site at <code class="code-chip">x.pcstyle.dev</code> runs FxTwitter + syndication only. Firecrawl is documented for self-hosted deploys and is not configured in production.
        </div>
      </article>
    </section>
  </main>

  <footer class="border-t border-[#23252a] bg-[#08090a]">
    <div class="mx-auto flex max-w-[1200px] flex-col gap-4 px-8 py-10 text-[14px] text-[#8a8f98] sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-6">
        <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="footer-link">GitHub</a>
        <a href="#top" class="footer-link font-mono">x.md</a>
        <a href="#hosted" class="footer-link">Hosted</a>
        <a href="#docs" class="footer-link">Docs</a>
        <a href="#routes" class="footer-link">API</a>
      </div>
      <p class="text-[#62666d]">Not affiliated with X Corp.</p>
    </div>
  </footer>
</div>
`

setupConvertForm(app)
