/**
 * The about / contact / privacy / terms pages.
 *
 * Pure string builders with no DOM or CSS imports, like `landing.ts`, so the
 * Vite prerender plugin can render them into their root HTML files at build
 * time. Agents check these pages to decide whether a service is real, so the
 * prose has to be in the raw HTML and every claim has to be true.
 */
import { footerHtml, headerHtml, type PageKind } from './chrome'

const REPO = 'https://github.com/pc-style/x-md'
const ISSUES = `${REPO}/issues`

export type PageSlug = 'about' | 'contact' | 'privacy' | 'terms'

interface PageShell {
  page: PageKind
  eyebrow: string
  heading: string
  lede: string
  body: string
}

function pageShell({ page, eyebrow, heading, lede, body }: PageShell): string {
  return `
<div class="x-root w-full max-w-full overflow-x-hidden">
  <a href="#content" class="skip-link">Skip to content</a>
  ${headerHtml({ page })}

  <main id="content" class="w-full max-w-full overflow-x-hidden">
    <article class="mx-auto max-w-[860px] px-6 pt-16 pb-24 sm:px-8 sm:pt-24 md:pb-32">
      <p class="eyebrow eyebrow-accent">${eyebrow}</p>
      <h1 class="mt-5 text-[clamp(2.3rem,5vw,3.6rem)] leading-[1.05] font-black tracking-tight text-ink">${heading}</h1>
      <p class="page-lede">${lede}</p>
      <div class="page-prose mt-12">
${body}
      </div>
    </article>
  </main>

  ${footerHtml(page)}
</div>
`
}

export function aboutHtml(): string {
  return pageShell({
    page: 'about',
    eyebrow: 'About',
    heading: 'A read-only door into public X content.',
    lede: `x.md turns public X (formerly Twitter) posts, threads, profiles, search results, and
      follower lists into Markdown and JSON that software can read. It is free, open source,
      and run by one independent developer.`,
    body: `
        <h2>What x.md is</h2>
        <p>
          x.md is a small HTTP service with one convention at its centre: keep the path, change the host.
          Take any public post URL on <strong>x.com</strong>, replace the host with
          <strong>x.pcstyle.dev</strong>, and the same path answers with the post as Markdown instead of a
          web application. The reply chain comes back with it, quoted posts are nested inline, images and
          videos survive as links, and long-form X Articles convert with their headings and lists intact.
          The same host swap works for profiles, post search, followers, and following, and every route can
          return structured JSON instead with <strong>?format=json</strong> or an
          <strong>Accept: application/json</strong> header.
        </p>

        <h2>Why it exists</h2>
        <p>
          x.com does not render its content without JavaScript. A shell script, a CI job, a note-taking
          tool, or an AI agent that fetches a status URL gets hundreds of kilobytes of markup, no post text,
          and the sentence &ldquo;JavaScript is not available.&rdquo; The information is public, but it is
          effectively unreadable to anything that is not a browser. That is a small problem that shows up
          constantly: a link in an issue, a citation in a document, a source an agent is asked to check.
          x.md exists to make that one fetch work.
        </p>

        <h2>How it works</h2>
        <p>
          x.md is a set of stateless serverless functions hosted on Vercel. A request is parsed into a
          handle and a post ID, fetched from a public upstream provider &mdash; FxTwitter and X&rsquo;s own
          syndication endpoint are the defaults &mdash; normalised into a common shape, and rendered as
          compact Markdown. Results are cached briefly so that repeated reads of the same URL do not hit
          upstream again. Callers need no account and no X API key on the hosted path. Content negotiation
          decides the response: browsers get a readable HTML page, agents that ask for
          <strong>text/markdown</strong> get Markdown, link-preview bots get Open Graph embed HTML, and
          <a href="/docs">the documentation</a> describes every parameter.
        </p>

        <h2>Scope and limits</h2>
        <p>
          x.md is strictly read-only. It never posts, replies, follows, likes, or bookmarks, and it holds no
          X credentials on your behalf. It can only return content X already serves publicly: protected,
          private, suspended, and deleted accounts and posts are never available, and X Lists and direct
          messages are not supported. The service is in beta &mdash; routes and output fields can change
          when upstream providers change &mdash; and it is rate limited and cached for interactive use
          rather than bulk collection. Being able to read something here does not grant you rights to
          redistribute it; see the <a href="/terms">terms</a>.
        </p>

        <h2>Who maintains it</h2>
        <p>
          x.md is built and maintained by one independent developer, pcstyle
          (<a href="${REPO}" target="_blank" rel="noreferrer">pc-style on GitHub</a>). It is not a company
          product, and it is <strong>not affiliated with, endorsed by, or connected to X Corp</strong>.
          The entire source is public and MIT-licensed, so you can read exactly what the service does, open
          an issue when it is wrong, or
          <a href="/docs/self-hosting">deploy your own copy</a> and run the same host swap on your own
          domain. Development happens in the open in the repository.
        </p>

        <h2>Where to go next</h2>
        <ul>
          <li><a href="/docs">API documentation</a> &mdash; routes, parameters, output formats, and limits.</li>
          <li><a href="/openapi.json">OpenAPI description</a> and <a href="/llms.txt">llms.txt</a> &mdash; the machine-readable descriptions of the same surface.</li>
          <li><a href="/contact">Contact</a> &mdash; how to report a bug or a security issue.</li>
          <li><a href="/privacy">Privacy</a> &mdash; what the service does and does not store.</li>
        </ul>`,
  })
}

export function contactHtml(): string {
  return pageShell({
    page: 'contact',
    eyebrow: 'Contact',
    heading: 'Everything goes through the repository.',
    lede: `x.md is maintained by one developer, in public, on GitHub. There is no support desk and no
      contact form &mdash; using the repository keeps answers searchable for the next person who hits the
      same problem.`,
    body: `
        <h2>Bugs and feature requests</h2>
        <p>
          Open an issue at
          <a href="${ISSUES}" target="_blank" rel="noreferrer">github.com/pc-style/x-md/issues</a>.
          Bug reports are much faster to fix when they include the exact URL you requested, the parameters
          you used, what you expected, what you actually received, and roughly when it happened. Provider
          behaviour changes without notice, so a request that worked last week and fails today is useful
          information, not noise.
        </p>

        <h2>Questions, ideas, and integrations</h2>
        <p>
          Use
          <a href="${REPO}/discussions" target="_blank" rel="noreferrer">GitHub Discussions</a>
          for questions about how to use the service, output-format proposals, or anything you are building
          on top of it. For short public questions you can also reach the maintainer on X at
          <a href="https://x.com/pcstyle53" target="_blank" rel="noreferrer">@pcstyle53</a>. Contributions
          are welcome; read
          <a href="${REPO}/blob/main/CONTRIBUTING.md" target="_blank" rel="noreferrer">CONTRIBUTING.md</a>
          first, since it describes the checks a pull request has to pass.
        </p>

        <h2>Security reports</h2>
        <p>
          Read
          <a href="${REPO}/blob/main/SECURITY.md" target="_blank" rel="noreferrer">SECURITY.md</a>
          before reporting anything. Vulnerabilities go through the repository&rsquo;s
          <a href="${REPO}/security/advisories" target="_blank" rel="noreferrer">Security tab</a> as a
          private vulnerability report, not through a public issue. Do not include API keys,
          private-account data, or sensitive search terms in a public report. The latest tagged release and
          the current <strong>main</strong> branch are the supported versions.
        </p>

        <h2>Content and removal questions</h2>
        <p>
          x.md renders content that X already serves publicly, at the moment you request it. When a post is
          deleted or an account is made private or protected on X, x.md stops returning it. If you believe
          something reached you through x.md that should not have, open an issue describing the route
          &mdash; without pasting private data into it &mdash; and it will be looked at. The
          <a href="/privacy">privacy page</a> explains what the service retains.
        </p>

        <h2>What to expect</h2>
        <p>
          x.md is a free, beta, single-maintainer project. There is no service level agreement and no
          guaranteed response time; issues are answered on a best-effort basis, usually fastest for
          reproducible bugs and security reports. No email address, phone number, or postal contact is
          published for the project &mdash; the GitHub channels above are the complete list, and anything
          claiming to be an official x.md support address is not.
        </p>`,
  })
}

export function privacyHtml(): string {
  return pageShell({
    page: 'privacy',
    eyebrow: 'Privacy',
    heading: 'No accounts, no profiles, very little kept.',
    lede: `x.md has no sign-in and no user accounts, so there is nothing to build a profile from. This page
      describes what actually happens to a request, taken from the code in the public repository.`,
    body: `
        <h2>No accounts, no credentials</h2>
        <p>
          There is no registration, login, password, or session. x.md never asks for your X credentials,
          cannot act on an X account, and has no way to associate a request with a person. Private API keys
          exist for a small number of callers who need a larger search allowance; they are handed out
          privately, only a SHA-256 hash of the secret is stored, and they carry a label and a limit &mdash;
          not a person.
        </p>

        <h2>What a request necessarily involves</h2>
        <p>
          Like any website, your request reaches Vercel&rsquo;s edge with an IP address and ordinary HTTP
          headers, and Vercel operates the hosting and CDN under its own terms. Inside the application, the
          client IP address is read from the standard proxy headers for one purpose: rate limiting. It
          becomes part of a counter key in a key/value store, the counter holds only a number, and the key
          expires automatically &mdash; roughly two minutes for the per-minute search gate and about half an
          hour for the fifteen-minute search budget. No URL, query, response, or header is written beside
          it. Rate limits protect scarce upstream capacity, above all for live search.
        </p>

        <h2>Caching</h2>
        <p>
          Conversion and browse results are cached under a key derived from the request parameters, in the
          serverless instance&rsquo;s memory and at Vercel&rsquo;s CDN, for one hour by default. What is
          cached is public X content, not anything about you, and <strong>?nocache=true</strong> bypasses
          it. Responses to requests that carry an API key are marked <strong>private, no-store</strong> so
          they can never be served from a shared cache to somebody else.
        </p>

        <h2>Analytics</h2>
        <p>
          Two optional, metadata-only instrumentations run on the production deployment when they are
          configured. Neither one is required for the service to work, and both are absent from local and
          preview builds.
        </p>
        <ul>
          <li>
            <strong>Server-side request counting.</strong> One event per completed production function
            response, carrying only the route name, HTTP method, status code, duration in milliseconds,
            cache outcome, whether the caller used a key, and the environment. The request URL, query,
            headers, body, and error text are never serialised. Person profiles and GeoIP enrichment are
            disabled and the IP field is explicitly sent as null. Anonymous callers get a fresh random
            identifier per request, so events cannot be linked across requests; API-key callers get an HMAC
            of the internal key ID, never the key itself.
          </li>
          <li>
            <strong>Landing-page analytics.</strong> The homepage &mdash; and only the homepage &mdash; may
            load PostHog to count page views, page leaves, and two interactions: requesting a conversion and
            copying the skill install command. Properties are reduced to an allowlist of browser, device,
            viewport, and session fields; the reported URL is rewritten to the bare origin so query strings
            and referrers are not sent. Autocapture, session recording, heatmaps, surveys, exception
            capture, and person profiles are all switched off. Vercel Web Analytics is also injected on the
            landing page.
          </li>
        </ul>

        <h2>Cookies and local storage</h2>
        <p>
          The API sets no cookies at all. In the browser, x.md stores your light/dark theme choice in
          <strong>localStorage</strong> under <strong>x-md-theme</strong>, and the analytics library, when
          it runs, keeps its own anonymous identifier there. One optional cookie exists,
          <strong>__Host-xmd_actor</strong>: it holds an anonymous UUID, is set only in builds where the
          operator has enabled the archive actor bridge, and is scoped
          <strong>Secure; SameSite=Lax; Path=/</strong> with a 30-day lifetime. Opting out writes a second
          cookie, <strong>__Host-xmd_archive_optout=1</strong>, which the server also honours.
        </p>

        <h2>The optional public-result archive</h2>
        <p>
          The repository contains an opt-in capture path that sends the structured public results of
          successful GET responses &mdash; post fields, public author fields, media metadata &mdash; to
          PostHog for later export. It is <strong>disabled by default</strong> and requires an operator to
          set an explicit environment flag plus a separate server-only secret; it never runs in local or
          preview builds. Its payloads use strict field allowlists that exclude rendered response bodies,
          incoming URLs and search queries, request headers, IP addresses, credentials, and cursors, and
          protected authors are excluded entirely.
          <a href="/docs/archive">The archive documentation</a> is the full contract.
        </p>

        <h2>Your controls</h2>
        <ul>
          <li>Send <strong>DNT: 1</strong>, <strong>Sec-GPC: 1</strong>, or <strong>X-Xmd-Archive-Opt-Out: 1</strong> with a request, or set the <strong>__Host-xmd_archive_optout=1</strong> cookie: archive capture is skipped and the landing-page analytics do not initialise.</li>
          <li>Use <strong>?nocache=true</strong> to bypass the application cache for a request.</li>
          <li>Block the third-party requests listed below, or run the service yourself &mdash; a <a href="/docs/self-hosting">self-hosted deployment</a> with no analytics variables configured sends nothing anywhere.</li>
        </ul>

        <h2>Third parties</h2>
        <p>
          Serving a request involves Vercel (hosting and CDN) and the upstream public X endpoints and
          FxTwitter that supply the content. When analytics are configured, events go to a PostHog
          instance. Loading the landing page in a browser additionally fetches a web font from Fontshare and
          a Product Hunt badge image; both are ordinary third-party requests made by your browser and can be
          blocked without affecting the API.
        </p>

        <h2>Changes</h2>
        <p>
          This page describes the behaviour of the code in the public repository, which is the authoritative
          record &mdash; every claim above can be checked against
          <a href="${REPO}" target="_blank" rel="noreferrer">the source</a>. Questions and corrections go to
          <a href="/contact">contact</a>. Last reviewed
          <time datetime="2026-09-08">8 September 2026</time>.
        </p>`,
  })
}

export function termsHtml(): string {
  return pageShell({
    page: 'terms',
    eyebrow: 'Terms',
    heading: 'Free, as-is, read-only.',
    lede: `Plain-language terms for using the hosted service at x.pcstyle.dev. Using it means you accept
      them. They are short because the service is small: it reads content that X already publishes and
      hands it back as text.`,
    body: `
        <h2>The service</h2>
        <p>
          x.md is a free, read-only service that reformats public X content as Markdown or JSON. It has no
          accounts, takes no payment, and offers no paid tier. It never posts, replies, follows, likes, or
          bookmarks on anyone&rsquo;s behalf, and it only returns content that X serves publicly at the
          moment of the request.
        </p>

        <h2>Provided as is</h2>
        <p>
          The service is provided <strong>as is and as available, without warranty of any kind</strong>,
          express or implied, including any warranty of merchantability, fitness for a particular purpose,
          accuracy, or non-infringement. It is in beta and depends on upstream providers that can change or
          break without notice, so output can be incomplete, delayed, out of date, or wrong. Do not rely on
          it for anything where an error would matter without checking the source post yourself. To the
          maximum extent permitted by law, the maintainer is not liable for any loss or damage arising from
          use of the service.
        </p>

        <h2>Availability, limits, and changes</h2>
        <p>
          There is no uptime commitment and no service level agreement. Routes, parameters, output fields,
          cache behaviour, and rate limits may change or be withdrawn at any time, and the service may be
          slowed, restricted, or shut down without notice. Rate limits exist to keep scarce upstream
          capacity available to everyone; do not attempt to circumvent them, and do not use the service for
          bulk or firehose collection. If you need guaranteed capacity or stability,
          <a href="/docs/self-hosting">run your own deployment</a> &mdash; that is what the licence is for.
        </p>

        <h2>Your responsibilities</h2>
        <ul>
          <li>You are responsible for complying with <strong>X&rsquo;s own terms of service</strong> and with any law that applies to you. x.md is a client for public content; it does not grant you permission you would not otherwise have.</li>
          <li>Do not use the service to access or attempt to access anything non-public, or to work around access controls, authentication, or protection on X.</li>
          <li>Do not use it for unlawful purposes, for harassment, or to build dossiers on individuals.</li>
          <li>You are responsible for what you do with what you retrieve, including how you store, republish, or feed it into other systems.</li>
        </ul>

        <h2>Content and rights</h2>
        <p>
          Posts, profiles, and media belong to their authors and to the platform that hosts them. x.md
          claims no rights over the content it passes through and does not license it to you; public
          availability is not the same as permission to reuse. x.md is
          <strong>not affiliated with, endorsed by, or connected to X Corp</strong>. X and related names and
          logos are the trademarks of their respective owners and are used here only to describe what the
          service reads.
        </p>

        <h2>Software licence</h2>
        <p>
          The x.md source code is released under the
          <a href="${REPO}/blob/main/LICENSE" target="_blank" rel="noreferrer">MIT licence</a> and you are
          free to use, modify, and redistribute it under those terms. The licence covers the software only,
          never the X content that flows through it.
        </p>

        <h2>Changes to these terms</h2>
        <p>
          These terms can change; the current version is the one published here, and the full history is in
          <a href="${REPO}" target="_blank" rel="noreferrer">the public repository</a>. Continuing to use
          the service after a change means you accept the updated terms. Questions go to
          <a href="/contact">contact</a>. Last reviewed
          <time datetime="2026-09-08">8 September 2026</time>.
        </p>`,
  })
}

/** Slug to builder, keyed by the `data-page` attribute on each root HTML file. */
export const pageBuilders: Record<PageSlug, () => string> = {
  about: aboutHtml,
  contact: contactHtml,
  privacy: privacyHtml,
  terms: termsHtml,
}
