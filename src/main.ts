import './style.css'

const app = document.querySelector<HTMLDivElement>('#app')!

type ClerkInstance = {
  user: {
    primaryEmailAddress?: { emailAddress: string } | null
    username?: string | null
  } | null
  session?: { getToken: () => Promise<string | null> } | null
  addListener: (listener: () => void) => void
  openSignUp: (props?: { forceRedirectUrl?: string }) => void
  openSignIn: (props?: { forceRedirectUrl?: string }) => void
  signOut: () => Promise<void>
}

const CLERK_PUBLISHABLE_KEY = (
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ??
  import.meta.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ??
  ''
) as string

const EXAMPLE_HANDLE = 'trq212'
const EXAMPLE_ID = '2052809885763747935'
const EXAMPLE_X_URL = `https://x.com/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_HOSTED_URL = `https://x.pcstyle.dev/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`
const EXAMPLE_PATH = `/${EXAMPLE_HANDLE}/status/${EXAMPLE_ID}`

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

app.innerHTML = `
<div class="x-root w-full overflow-hidden">
  <header class="relative w-full border-b border-white/[0.08]">
    <nav aria-label="Primary" class="mx-auto flex h-[73px] max-w-[1200px] items-center justify-between px-8">
      <a href="#top" class="font-mono text-[17px] font-medium tracking-tight text-[#f7f8f8]">x.md</a>
      <div class="hidden items-center gap-1 md:flex">
        <a href="#hosted" class="nav-link h-8 px-3">Hosted</a>
        <a href="#docs" class="nav-link h-8 px-3">Docs</a>
        <a href="#pricing" class="nav-link h-8 px-3">Pricing</a>
        <a href="#agents" class="nav-link h-8 px-3">Agents</a>
        <a href="#routes" class="nav-link h-8 px-3">API</a>
      </div>
      <div class="flex items-center gap-3">
        <a href="https://github.com/pc-style/x-md" target="_blank" rel="noreferrer" class="nav-link hidden h-8 px-3 sm:flex">GitHub</a>
        <button type="button" data-auth-action="sign-in" class="nav-link hidden h-8 px-3 sm:flex">Sign in</button>
        <button type="button" data-auth-action="sign-up" class="btn-primary flex h-8 items-center rounded-full px-3.5 text-[13px]">Sign up free</button>
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
            <button type="button" data-auth-action="sign-up" class="btn-primary flex h-10 items-center rounded-full px-4 text-[13px]">Create free account</button>
            <a href="#convert" class="btn-ghost flex h-10 items-center rounded-full px-3.5 text-[13px]">Convert without account</a>
            <a href="#pricing" class="btn-ghost flex h-10 items-center rounded-full px-3.5 text-[13px]">Premium plans</a>
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
        <p class="mt-2 text-[16px] text-[#8a8f98]">Paste any public X status URL. Opens Markdown at the same path on this site (includes reply-chain context by default).</p>
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
          Opens <code class="code-chip">${EXAMPLE_PATH}?thread=full</code> here — the same trick as swapping <code class="code-chip">x.com</code> → <code class="code-chip">x.pcstyle.dev</code> in the link.
        </p>
      </div>
    </section>



    <section id="pricing" class="mx-auto max-w-[1200px] px-8 pb-[120px]">
      <div class="mb-10 max-w-[640px]">
        <p class="eyebrow eyebrow-accent mb-3">Premium</p>
        <h2 class="text-[clamp(32px,4vw,48px)] font-medium leading-[1.05] tracking-[-0.03em] text-[#f7f8f8]">Free conversion stays free. Premium social workflows use credits.</h2>
        <p class="mt-4 text-[17px] leading-[1.6] text-[#8a8f98]">x.md uses Clerk accounts, Convex-backed API keys, and Autumn + Stripe billing. Autumn is the source of truth for plans, entitlements, checkout, and social credit balances.</p>
      </div>
      <div class="grid gap-4 lg:grid-cols-3">
        <div class="pricing-card">
          <p class="font-mono text-[13px] text-[#55ccff]">Free</p>
          <h3 class="mt-3 text-[28px] font-semibold text-[#f7f8f8]">$0<span class="text-[14px] font-normal text-[#8a8f98]">/mo</span></h3>
          <ul class="mt-5 space-y-2 text-[14px] leading-relaxed text-[#8a8f98]">
            <li>Anonymous X Markdown conversion</li>
            <li>Social link bundle</li>
            <li>Conversation map</li>
            <li>Media manifest</li>
          </ul>
        </div>
        <div class="pricing-card pricing-card-featured">
          <p class="font-mono text-[13px] text-[#55ccff]">Starter</p>
          <h3 class="mt-3 text-[28px] font-semibold text-[#f7f8f8]">$5<span class="text-[14px] font-normal text-[#8a8f98]">/mo</span></h3>
          <p class="mt-2 text-[14px] text-[#d0d6e0]">250 social credits/month</p>
          <ul class="mt-5 space-y-2 text-[14px] leading-relaxed text-[#8a8f98]">
            <li>Obsidian social note templates</li>
            <li>Quote expansion</li>
            <li>JSON-LD basic export</li>
          </ul>
          <button type="button" data-plan="starter" class="btn-primary mt-6 flex h-10 w-full items-center rounded-full px-4 text-[13px]">Upgrade with Autumn</button>
        </div>
        <div class="pricing-card">
          <p class="font-mono text-[13px] text-[#55ccff]">Pro</p>
          <h3 class="mt-3 text-[28px] font-semibold text-[#f7f8f8]">$15<span class="text-[14px] font-normal text-[#8a8f98]">/mo</span></h3>
          <p class="mt-2 text-[14px] text-[#d0d6e0]">1,500 social credits/month</p>
          <ul class="mt-5 space-y-2 text-[14px] leading-relaxed text-[#8a8f98]">
            <li>Thread briefing and author dossiers</li>
            <li>Cross-platform parser</li>
            <li>Context-window safe mode</li>
            <li>Bulk JSON-LD archive export</li>
          </ul>
          <button type="button" data-plan="pro" class="btn-ghost mt-6 flex h-10 w-full items-center justify-center rounded-full px-4 text-[13px]">Upgrade to Pro</button>
        </div>
      </div>
      <div class="mt-6 overflow-x-auto rounded-xl border border-[#23252a]">
        <table class="docs-table">
          <thead><tr><th>Premium feature</th><th>Credits</th><th>API mode</th></tr></thead>
          <tbody>
            <tr><td>Quote-post expansion</td><td>1</td><td><code>premium=quote_expansion</code></td></tr>
            <tr><td>Obsidian social note templates</td><td>1</td><td><code>premium=obsidian_templates</code></td></tr>
            <tr><td>Thread briefing mode</td><td>3</td><td><code>premium=thread_briefing</code></td></tr>
            <tr><td>Context-window safe mode</td><td>3</td><td><code>premium=context_safe_mode</code></td></tr>
            <tr><td>Cross-platform social parser</td><td>3</td><td><code>premium=cross_platform_parser</code></td></tr>
            <tr><td>Social archive JSON-LD bulk/export</td><td>5</td><td><code>premium=jsonld_bulk_export</code></td></tr>
            <tr><td>Author dossier</td><td>10</td><td><code>premium=author_dossier</code></td></tr>
          </tbody>
        </table>
      </div>
      <div id="account" class="account-card mt-6">
        <div>
          <p class="eyebrow eyebrow-muted mb-2">Account</p>
          <h3 class="text-[22px] font-semibold text-[#f7f8f8]">Sign up to unlock premium workflows and API keys.</h3>
          <p data-account-status class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Create a free account first, then upgrade when you need social credits.</p>
          <p data-api-key-output class="mt-4 hidden rounded-lg border border-[#23252a] bg-[#08090a] p-3 font-mono text-[12px] leading-relaxed text-[#d0d6e0]"></p>
        </div>
        <div class="flex flex-col gap-3 sm:min-w-[220px]">
          <button type="button" data-auth-action="sign-up" class="btn-primary flex h-10 items-center rounded-full px-4 text-[13px]">Sign up free</button>
          <button type="button" data-auth-action="sign-in" class="btn-ghost flex h-10 items-center justify-center rounded-full px-4 text-[13px]">Sign in</button>
          <button type="button" data-account-action="create-key" class="btn-ghost hidden h-10 items-center justify-center rounded-full px-4 text-[13px]">Create API key</button>
          <button type="button" data-account-action="portal" class="btn-ghost hidden h-10 items-center justify-center rounded-full px-4 text-[13px]">Manage billing</button>
          <button type="button" data-auth-action="sign-out" class="btn-ghost hidden h-10 items-center justify-center rounded-full px-4 text-[13px]">Sign out</button>
        </div>
      </div>
      <div class="info-banner-muted mt-4">
        Account API surface: <code class="code-chip">POST /api/billing?plan=starter|pro</code> starts Autumn checkout, <code class="code-chip">POST /api/billing?action=portal</code> opens the Stripe portal through Autumn, and <code class="code-chip">/api/api-keys</code> creates/revokes hashed <code class="code-chip">xmd_...</code> tokens for <code class="code-chip">Authorization: Bearer</code> requests.
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
              <li><strong class="text-[#f7f8f8]">No paid scrape fallback</strong> unless configured by the maintainer</li>
            </ul>
          </div>
          <div class="compare-tile">
            <h4>Self-host (your Vercel project)</h4>
            <ul class="mt-3 space-y-2 text-[14px] leading-relaxed text-[#8a8f98]">
              <li>Same FxTwitter + syndication chain</li>
              <li>Optional <code class="code-chip">CONTEXT_DEV_API_KEY</code> and <code class="code-chip">FIRECRAWL_API_KEY</code> scrape fallbacks</li>
              <li>Your cache TTL and env vars</li>
              <li>Same URL swap on your domain</li>
            </ul>
          </div>
        </div>
        <p class="mt-4 text-[14px] text-[#62666d]">
          <code class="code-chip">X-Source</code> is <code class="code-chip">fxtwitter</code> or <code class="code-chip">syndication</code> by default. Self-hosted deploys can also return <code class="code-chip">contextdev</code> or <code class="code-chip">firecrawl</code> when keys are set.
        </p>
      </article>

      <div class="info-banner mb-16">
        <strong class="font-medium text-[#f7f8f8]">Provider chain:</strong> FxTwitter for rich data, X syndication as fallback.
        <span class="text-[#8a8f98]"> Context.dev and Firecrawl are optional </span>
        <strong class="font-medium text-[#f7f8f8]">self-host fallbacks</strong>
        <span class="text-[#8a8f98]"> — set </span>
        <code class="code-chip text-[#f7f8f8]">CONTEXT_DEV_API_KEY</code>
        <span class="text-[#8a8f98]"> and/or </span>
        <code class="code-chip text-[#f7f8f8]">FIRECRAWL_API_KEY</code>
        <span class="text-[#8a8f98]"> on your own deploy.</span>
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
bunx skills add pc-style/x-md --list

# global install (recommended — works across projects)
bunx skills add pc-style/x-md -g -y \\
  --skill read-x-links-vercel --skill read-x-links-local

# or project-only, from an x-md checkout
bunx skills add pc-style/x-md -y \\
  --skill read-x-links-vercel --skill read-x-links-local</pre>
        <div class="mt-8 grid gap-4 lg:grid-cols-2">
          <div class="compare-tile">
            <h4>read-x-links-vercel</h4>
            <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Hosted API only — no local repo or Bun required. Uses FxTwitter + syndication on x.pcstyle.dev by default.</p>
            <pre class="code-block mt-4 text-[12px]"># after bunx skills add …
~/.agents/skills/read-x-links-vercel/scripts/read-x.sh \\
  "${EXAMPLE_X_URL}"

# or from this repo without installing:
./skills/read-x-links-vercel/scripts/read-x.sh \\
  "${EXAMPLE_X_URL}"</pre>
          </div>
          <div class="compare-tile">
            <h4>read-x-links-local</h4>
            <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Full local CLI — threads, Obsidian output, optional Context.dev/Firecrawl when you set fallback API keys.</p>
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
          JSON: <code class="code-chip">Accept: application/json</code> includes <code class="code-chip">source</code> (<code class="code-chip">fxtwitter</code> | <code class="code-chip">syndication</code> by default; <code class="code-chip">contextdev</code> and <code class="code-chip">firecrawl</code> when configured).
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
                <td>full</td>
                <td class="font-mono text-[12px]">off, full, conversation, 2-100</td>
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
              <tr>
                <td><code>premium</code></td>
                <td>—</td>
                <td class="text-[#d0d6e0]">Authenticated premium mode; requires Clerk JWT or <code class="code-chip">Authorization: Bearer xmd_...</code></td>
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
            <strong class="text-[17px] font-medium text-[#f7f8f8]">Context.dev</strong>
            <span class="text-[14px] text-[#8a8f98]">Optional scrape fallback when you set <code class="code-chip">CONTEXT_DEV_API_KEY</code></span>
          </div>
          <div class="provider-row">
            <strong class="text-[17px] font-medium text-[#f7f8f8]">Firecrawl</strong>
            <span class="text-[14px] text-[#8a8f98]">Optional final scrape fallback when you set <code class="code-chip">FIRECRAWL_API_KEY</code></span>
          </div>
        </div>
        <div class="info-banner-muted mt-6">
          The default chain is FxTwitter → syndication. If you configure one or both optional keys, the chain extends to Context.dev → Firecrawl.
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
        <a href="#pricing" class="footer-link">Pricing</a>
        <a href="#routes" class="footer-link">API</a>
      </div>
      <p class="text-[#62666d]">Not affiliated with X Corp.</p>
    </div>
  </footer>
</div>
`

setupConvertForm(app)
void setupAccountFlow(app)

async function setupAccountFlow(root: HTMLElement) {
  const clerk = await loadClerk(root)
  updateAccountUi(root, clerk)

  if (!clerk) return

  clerk.addListener(() => updateAccountUi(root, clerk))

  root.querySelectorAll<HTMLButtonElement>('[data-auth-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.authAction
      if (action === 'sign-up') clerk.openSignUp({ forceRedirectUrl: window.location.href })
      if (action === 'sign-in') clerk.openSignIn({ forceRedirectUrl: window.location.href })
      if (action === 'sign-out') await clerk.signOut()
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach((button) => {
    button.addEventListener('click', async () => {
      const plan = button.dataset.plan
      if (!plan) return
      if (!clerk.user) {
        clerk.openSignUp({ forceRedirectUrl: window.location.href })
        return
      }
      await postWithClerkToken(clerk, button, `/api/billing?plan=${encodeURIComponent(plan)}`, 'Opening checkout…', (payload) => {
        if (!payload.url) throw new Error('Checkout unavailable')
        window.location.href = payload.url
      })
    })
  })

  root.querySelector<HTMLButtonElement>('[data-account-action="portal"]')?.addEventListener('click', async (event) => {
    await postWithClerkToken(clerk, event.currentTarget as HTMLButtonElement, '/api/billing?action=portal', 'Opening portal…', (payload) => {
      if (!payload.url) throw new Error('Portal unavailable')
      window.location.href = payload.url
    })
  })

  root.querySelector<HTMLButtonElement>('[data-account-action="create-key"]')?.addEventListener('click', async (event) => {
    await postWithClerkToken(clerk, event.currentTarget as HTMLButtonElement, '/api/api-keys', 'Creating key…', (payload) => {
      const output = root.querySelector<HTMLElement>('[data-api-key-output]')
      if (!payload.apiKey || !output) throw new Error('API key unavailable')
      output.classList.remove('hidden')
      output.textContent = `Copy this key now. It will not be shown again:
${payload.apiKey}`
    })
  })
}

async function loadClerk(root: HTMLElement): Promise<ClerkInstance | null> {
  if (!CLERK_PUBLISHABLE_KEY) {
    root.querySelectorAll<HTMLButtonElement>('[data-auth-action], [data-plan], [data-account-action]').forEach((button) => {
      button.disabled = true
    })
    const status = root.querySelector<HTMLElement>('[data-account-status]')
    if (status) status.textContent = 'Clerk is not configured on this deploy yet. Add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to enable sign-up.'
    return null
  }

  const { Clerk } = await import('@clerk/clerk-js')
  const clerk = new Clerk(CLERK_PUBLISHABLE_KEY)
  await clerk.load()
  return clerk as ClerkInstance
}

function updateAccountUi(root: HTMLElement, clerk: ClerkInstance | null) {
  const signedIn = !!clerk?.user
  const email = clerk?.user?.primaryEmailAddress?.emailAddress ?? clerk?.user?.username ?? 'your account'
  root.querySelectorAll<HTMLElement>('[data-auth-action="sign-up"], [data-auth-action="sign-in"]').forEach((el) => {
    el.classList.toggle('hidden', signedIn)
  })
  root.querySelectorAll<HTMLElement>('[data-auth-action="sign-out"], [data-account-action]').forEach((el) => {
    el.classList.toggle('hidden', !signedIn)
    el.classList.toggle('flex', signedIn)
  })
  const status = root.querySelector<HTMLElement>('[data-account-status]')
  if (status) {
    status.textContent = signedIn
      ? `Signed in as ${email}. You can upgrade, manage billing, or create an API key for agent access.`
      : 'Create a free account first, then upgrade when you need social credits.'
  }
}

async function postWithClerkToken(
  clerk: ClerkInstance,
  button: HTMLButtonElement,
  path: string,
  pendingLabel: string,
  onSuccess: (payload: Record<string, string>) => void,
) {
  button.disabled = true
  const original = button.textContent
  button.textContent = pendingLabel
  try {
    const token = await clerk.session?.getToken()
    const response = await fetch(path, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
    const payload = await response.json() as Record<string, string>
    if (!response.ok) throw new Error(payload.error ?? 'Request failed')
    onSuccess(payload)
  } catch (error) {
    button.textContent = error instanceof Error ? error.message : 'Request failed'
    setTimeout(() => { button.textContent = original }, 2200)
    button.disabled = false
  }
}
