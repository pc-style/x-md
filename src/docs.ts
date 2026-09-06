import './style.css'
import { footerHtml, headerHtml, setupLinkPrefetch, setupMobileMenu, setupTheme } from './chrome'

const app = document.querySelector<HTMLDivElement>('#app')!
const example = 'https://x.pcstyle.dev/trq212/status/2052809885763747935'

const SECTIONS = [
  { id: 'start', label: 'Quick start' },
  { id: 'posts', label: 'Posts and conversations' },
  { id: 'browse', label: 'Profiles and browse' },
  { id: 'json', label: 'Structured output' },
  { id: 'agents', label: 'AI agents' },
  { id: 'reliability', label: 'Caching and reliability' },
  { id: 'deploy', label: 'Self-host' },
]

const links = SECTIONS.map(({ id, label }) => `<a href="#${id}" class="docs-nav-link" data-section-link="${id}">${label}</a>`).join('\n')

app.innerHTML = `
<div class="x-root w-full overflow-x-clip">
  <a href="#docs-content" class="skip-link">Skip to content</a>
  ${headerHtml({ page: 'docs' })}
  <main class="mx-auto max-w-[1120px] px-6 pb-[112px] sm:px-8">
    <div class="pt-16 pb-12 sm:pt-20">
      <p class="eyebrow eyebrow-accent mb-3">Documentation</p>
      <h1 class="hero-h max-w-4xl text-[clamp(2.2rem,4.5vw,3.4rem)] leading-[1.05] font-semibold text-ink">Browse X as Markdown</h1>
      <p class="mt-4 max-w-[620px] text-[17px] leading-[1.6] text-ink-3">Compact, source-linked output for agents, with structured JSON when you need the underlying data.</p>
    </div>
    <div class="grid gap-12 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Docs sections" class="hidden lg:block"><div class="sticky top-24 flex flex-col gap-0.5"><p class="eyebrow eyebrow-muted mb-3 px-3">On this page</p>${links}</div></nav>
      <div id="docs-content" class="min-w-0 max-w-[760px]">
        <details class="mb-8 rounded-xl border border-hair bg-raised lg:hidden"><summary class="cursor-pointer list-none px-5 py-3.5 text-[14px] font-medium text-ink">On this page</summary><div class="flex flex-col gap-0.5 border-t border-hair px-2 py-2">${links}</div></details>

        <article id="start" class="docs-article">
          <p class="eyebrow eyebrow-muted mb-3">Hosted API</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">Replace the host</h2>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">Keep a public status path and replace <code class="code-chip">x.com</code> with <code class="code-chip">x.pcstyle.dev</code>. Markdown is compact by default, and every returned post and reply includes its X source URL. Discord, Telegram, and Slack get Open Graph embeds instead of the Markdown page.</p>
          <pre class="code-block mt-6">https://x.com/trq212/status/2052809885763747935
        ↓
${example}

curl -sS -H "Accept: text/markdown" "${example}"</pre>
          <div class="info-banner mt-6"><strong class="font-medium text-ink">Public data only.</strong><span class="text-ink-3"> Private accounts and public X lists are unavailable.</span></div>
        </article>

        <article id="posts" class="docs-article">
          <p class="eyebrow eyebrow-muted mb-3">Conversion</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">Posts, threads, and replies</h2>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">Search supports Latest, Top, Photos, Videos, and Users (case-insensitive); <code class="code-chip">media</code> aliases Photos. Users returns profiles in the JSON <code class="code-chip">users</code> field. Photos, Videos, and Users require configured X sessions. Latest and Top can fall back to web-indexed snippets when live search is unavailable. Limits: 75 uncached searches per minute per IP and 100 upstream calls per account per 15 minutes. Page walks and failed account attempts consume account quota; cache hits are free. Counters are per instance unless shared KV is configured.</p>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">The default response includes available parents, the author's thread, and top replies. It labels conversation roles and emits direct images, video URLs, thumbnails, metadata, and available bitrate variants. X Articles are included when the provider supplies their blocks.</p>
          <div class="mt-6 overflow-x-auto rounded-xl border border-line"><table class="docs-table"><thead><tr><th>Param</th><th>Default</th><th>Values</th></tr></thead><tbody>
            <tr><td><code>full</code></td><td>false</td><td><code>true</code>, <code>1</code>, or <code>yes</code> adds dates, stats, and expanded details</td></tr>
            <tr><td><code>format</code></td><td>markdown</td><td><code>markdown</code>, <code>obsidian</code>, <code>json</code></td></tr>
            <tr><td><code>thread</code></td><td>full</td><td><code>off</code>, <code>full</code>, <code>conversation</code>, or <code>2–100</code></td></tr>
            <tr><td><code>context</code></td><td>full</td><td><code>full</code> or <code>thread</code></td></tr>
            <tr><td><code>replies</code></td><td>top</td><td><code>top</code>, <code>recent</code>, <code>off</code></td></tr>
            <tr><td><code>userinfo</code></td><td>off</td><td><code>off</code>, <code>author</code>, <code>all</code></td></tr>
            <tr><td><code>nocache</code></td><td>false</td><td><code>true</code>, <code>1</code>, or <code>yes</code></td></tr>
          </tbody></table></div>
          <pre class="code-block mt-6"># Expanded output, with no unrelated replies
curl -sS "${example}?full=true&amp;replies=off"

# Author thread only, capped at 20 posts
curl -sS "${example}?context=thread&amp;thread=20"

# Query-style conversion
curl -sS -G "https://x.pcstyle.dev/api/convert" \\
  --data-urlencode "url=https://x.com/trq212/status/2052809885763747935"</pre>
          <p class="mt-4 text-[14px] leading-relaxed text-ink-4"><code class="code-chip">thread=off</code> returns only the requested post. Obsidian output is expanded regardless of <code class="code-chip">full</code>. Direct X CDN media URLs can expire or change.</p>
          <h3 class="mt-8 text-[19px] font-semibold text-ink">Chat embeds</h3>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">Paste the same <code class="code-chip">x.pcstyle.dev</code> status URL into Discord, Telegram, or Slack. Preview bots receive Open Graph HTML: author title, post text, quote/poll details, multiple images on Discord, video streams where supported, video thumbnails on Slack, and an oEmbed engagement line. Agents and <code class="code-chip">curl</code> still get Markdown unless they send a preview-bot user agent. Force Markdown or JSON with <code class="code-chip">Accept</code> or <code class="code-chip">?format=</code>.</p>
          <pre class="code-block mt-6">curl -sS -A "Discordbot/2.0" "${example}"
curl -sS -G "https://x.pcstyle.dev/oembed" --data-urlencode "url=https://x.com/nthglsn/status/2087920734702022870"</pre>
        </article>

        <article id="browse" class="docs-article">
          <p class="eyebrow eyebrow-muted mb-3">Browse</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">Profiles, search, and connections</h2>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3"><code class="code-chip">/:handle</code> returns profile data and the latest 20 original posts by default; replies and reposts are filtered out. Search and connection routes use the same compact Markdown and <code class="code-chip">full=true</code> convention.</p>
          <div class="mt-6 space-y-0">
            <div class="provider-row"><strong class="text-[16px] font-medium text-ink">/:handle</strong><span class="text-[14px] text-ink-3">Profile and latest originals</span></div>
            <div class="provider-row"><strong class="text-[16px] font-medium text-ink">/search?q=…</strong><span class="text-[14px] text-ink-3"><code class="code-chip">feed=latest|top|photos|videos|users|media</code></span></div>
            <div class="provider-row"><strong class="text-[16px] font-medium text-ink">/:handle/followers</strong><span class="text-[14px] text-ink-3">Public followers</span></div>
            <div class="provider-row"><strong class="text-[16px] font-medium text-ink">/:handle/following</strong><span class="text-[14px] text-ink-3">Public following</span></div>
          </div>
          <pre class="code-block mt-6">curl -sS "https://x.pcstyle.dev/elonmusk"
curl -sS "https://x.pcstyle.dev/search?q=typescript&amp;feed=latest"
curl -sS "https://x.pcstyle.dev/elonmusk/followers?full=true"

# Direct handler usage
curl -sS -G "https://x.pcstyle.dev/api/browse" \\
  --data-urlencode "resource=search" \\
  --data-urlencode "q=typescript" \\
  --data-urlencode "feed=top"</pre>
          <h3 class="mt-8 text-[19px] font-semibold text-ink">Pagination</h3>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">Search supports Latest, Top, Photos, Videos, and Users (case-insensitive); <code class="code-chip">media</code> aliases Photos. Users returns profiles in the JSON <code class="code-chip">users</code> field. Photos, Videos, and Users require configured X sessions. Latest and Top can fall back to web-indexed snippets when live search is unavailable. Limits: 75 uncached searches per minute per IP and 100 upstream calls per account per 15 minutes. Page walks and failed account attempts consume account quota; cache hits are free. Counters are per instance unless shared KV is configured.</p>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">The default <code class="code-chip">limit</code> is 20 and the maximum is 20. Follow the opaque <code class="code-chip">nextCursor</code> as <code class="code-chip">cursor=…</code>, or request <code class="code-chip">page=1</code> through <code class="code-chip">page=10</code>; larger page values are clamped. Page mode walks upstream pages and can be slower, while a supplied cursor fetches one upstream page. Filtering can leave profile pages shorter than the requested limit.</p>
          <div class="info-banner-muted mt-6">The verified upstream API does not expose pinned-post markers or public X lists, so neither is inferred or fabricated.</div>
        </article>

        <article id="json" class="docs-article">
          <p class="eyebrow eyebrow-muted mb-3">Structured output</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">JSON for tools</h2>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">Add <code class="code-chip">?format=json</code> or send <code class="code-chip">Accept: application/json</code> on conversion or browse routes.</p>
          <pre class="code-block mt-6">curl -sS -H "Accept: application/json" "${example}"
curl -sS "https://x.pcstyle.dev/elonmusk?format=json"</pre>
          <p class="mt-4 text-[14px] leading-relaxed text-ink-4">Conversion JSON contains <code class="code-chip">markdown</code>, raw <code class="code-chip">posts</code>, URL, compact flag, warnings, count, provider source, format, and cache status. Browse JSON contains rendered Markdown plus profile/posts or users, pagination fields, and cache status.</p>
        </article>

        <article id="agents" class="docs-article">
          <p class="eyebrow eyebrow-muted mb-3">Automation</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">Install browse-x</h2>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">The hosted skill works across projects and calls <code class="code-chip">x.pcstyle.dev</code>; it needs no local checkout or provider keys.</p>
          <pre class="code-block mt-6">bunx skills add pc-style/x-md -g -y --skill browse-x</pre>
        </article>

        <article id="reliability" class="docs-article">
          <p class="eyebrow eyebrow-muted mb-3">Operations</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">Caching and reliability</h2>
          <p class="mt-3 text-[16px] leading-relaxed text-ink-3">Post conversion uses FxTwitter first, X syndication second, then optional Context.dev and Firecrawl fallbacks on self-hosted deployments. <code class="code-chip">X-Source</code> identifies the provider and <code class="code-chip">X-Cache</code> identifies cache status. Browse routes use FxTwitter directly.</p>
          <p class="mt-4 text-[16px] leading-relaxed text-ink-3">Responses cache for about an hour by default. <code class="code-chip">nocache=true</code> bypasses this application's cache, not upstream caches. Deleted, protected, delayed, rate-limited, or incomplete upstream data can reduce context, article bodies, quotes, media variants, counts, and pagination. Fallback conversion responses are commonly single-post and less detailed.</p>
        </article>

        <article id="deploy" class="docs-article !pb-0">
          <p class="eyebrow eyebrow-muted mb-3">Infrastructure</p>
          <h2 class="text-[24px] leading-tight font-semibold text-ink">Self-host on Vercel</h2>
          <pre class="code-block mt-6">git clone https://github.com/pc-style/x-md.git
cd x-md
bun install
cp .env.local.example .env.local
bun run build</pre>
          <p class="mt-4 text-[16px] leading-relaxed text-ink-3">Vercel uses the included rewrites for statuses, profiles, search, followers, and following. Optional <code class="code-chip">CONTEXT_DEV_API_KEY</code> and <code class="code-chip">FIRECRAWL_API_KEY</code> extend converter fallbacks; <code class="code-chip">CACHE_TTL_SECONDS</code>, <code class="code-chip">CACHE_DISABLED</code>, and <code class="code-chip">CACHE_PERSIST</code> control caching.</p>
        </article>
      </div>
    </div>
  </main>
  ${footerHtml()}
</div>`

setupMobileMenu(app)
setupTheme(app)
setupLinkPrefetch(app)
setupSectionHighlight(app)

function setupSectionHighlight(root: HTMLElement) {
  const navLinks = new Map<string, HTMLAnchorElement[]>()
  root.querySelectorAll<HTMLAnchorElement>('[data-section-link]').forEach((link) => {
    const id = link.dataset.sectionLink!
    navLinks.set(id, [...(navLinks.get(id) ?? []), link])
  })
  if (!('IntersectionObserver' in window)) return
  const visible = new Map<string, number>()
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => visible.set(entry.target.id, entry.isIntersecting ? entry.intersectionRatio : 0))
    const active = [...visible.entries()].filter(([, ratio]) => ratio > 0).sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!active) return
    navLinks.forEach((anchors, id) => anchors.forEach((anchor) => id === active ? anchor.setAttribute('aria-current', 'true') : anchor.removeAttribute('aria-current')))
  }, { rootMargin: '-80px 0px -40% 0px', threshold: [0, 0.2, 0.5, 1] })
  SECTIONS.forEach(({ id }) => { const section = root.querySelector(`#${id}`); if (section) observer.observe(section) })
}
