import './style.css'
import { fetchWithClerkToken, loadClerk, type ClerkInstance } from './clerk'
import { setupMaintenanceNotice } from './maintenance-notice'

const app = document.querySelector<HTMLDivElement>('#app')!

type AccountPayload = {
  user?: { id: string; email: string | null; name: string | null }
  plan?: { id: string | null; name: string | null; status: string | null } | null
  products?: Array<{ id: string | null; name: string | null; status: string | null }>
  credits?: { balance: number | null; includedUsage: number | null } | null
  billingError?: { code: string; message: string } | null
}

type ApiKeyRecord = {
  tokenPreview: string
  keyHash: string
  label?: string
  createdAt: number
  lastUsedAt?: number
  revokedAt?: number
}

function statusPathFromUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim())
    const host = parsed.hostname.replace(/^www\./, '')
    if (!['x.com', 'twitter.com', 'mobile.twitter.com', 'x.pcstyle.dev'].includes(host) && !host.endsWith('.vercel.app')) {
      return null
    }
    const match = parsed.pathname.match(/^\/([^/?#]+)\/status\/(\d+)\/?$/) ?? parsed.pathname.match(/^\/i\/status\/(\d+)\/?$/)
    if (!match) return null
    return match.length === 2 ? `/i/status/${match[1]}` : `/${match[1]}/status/${match[2]}`
  } catch {
    return null
  }
}

const PLAN_DETAILS: Record<string, { label: string; price: string; blurb: string }> = {
  free: { label: 'Free', price: '$0/mo', blurb: 'Anonymous conversion, no credits.' },
  starter: { label: 'Starter', price: '$5/mo', blurb: '250 social credits per month.' },
  pro: { label: 'Pro', price: '$15/mo', blurb: '1,500 social credits per month.' },
}

app.innerHTML = `
<div class="x-root min-h-screen w-full">
  <header class="w-full border-b border-white/[0.08]">
    <nav aria-label="Primary" class="mx-auto flex h-[73px] max-w-[1100px] items-center justify-between px-6 sm:px-8">
      <div class="flex items-center gap-4">
        <a href="/" class="font-mono text-[17px] font-medium tracking-tight text-[#f7f8f8]">x.md</a>
        <span class="hidden h-4 w-px bg-white/[0.12] sm:block"></span>
        <span class="hidden font-mono text-[12px] uppercase tracking-[0.08em] text-[#62666d] sm:block">Dashboard</span>
      </div>
      <div class="flex items-center gap-3">
        <a href="/#docs" class="nav-link hidden h-8 px-3 sm:flex">Docs</a>
        <a href="/#pricing" class="nav-link hidden h-8 px-3 sm:flex">Pricing</a>
        <div data-user-button class="hidden h-8 w-8"></div>
        <button type="button" data-action="sign-out" class="nav-link hidden h-8 px-3">Sign out</button>
      </div>
    </nav>
  </header>

  <main class="mx-auto max-w-[1100px] px-6 pb-[120px] pt-12 sm:px-8">
    <div data-state="loading" class="dash-state">
      <p class="font-mono text-[13px] text-[#62666d]">Loading your account…</p>
    </div>

    <div data-state="signed-out" class="dash-state hidden">
      <div class="account-card max-w-[560px]">
        <div>
          <p class="eyebrow eyebrow-accent mb-2">Dashboard</p>
          <h1 class="text-[24px] font-semibold text-[#f7f8f8]">Sign in to view your account</h1>
          <p class="mt-2 text-[14px] leading-relaxed text-[#8a8f98]">Your plan, social credits, and API keys live here.</p>
          <div class="mt-6 flex gap-3">
            <button type="button" data-action="sign-in" class="btn-primary flex h-10 items-center rounded-full px-4 text-[13px]">Sign in</button>
            <button type="button" data-action="sign-up" class="btn-ghost flex h-10 items-center rounded-full px-4 text-[13px]">Create account</button>
          </div>
        </div>
      </div>
    </div>

    <div data-state="not-configured" class="dash-state hidden">
      <div class="info-banner-muted max-w-[560px]">
        Clerk is not configured on this deploy. Set <code class="code-chip">VITE_CLERK_PUBLISHABLE_KEY</code> (or <code class="code-chip">NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code>) to enable accounts.
      </div>
    </div>

    <div data-state="ready" class="dash-state hidden">
      <div class="mb-10 flex flex-col gap-2">
        <p class="eyebrow eyebrow-accent">Account</p>
        <h1 data-greeting class="text-[clamp(28px,4vw,40px)] font-medium leading-[1.05] tracking-[-0.03em] text-[#f7f8f8]">Dashboard</h1>
        <p data-identity class="font-mono text-[13px] text-[#62666d]"></p>
      </div>

      <div class="grid gap-4 lg:grid-cols-3">
        <div class="pricing-card pricing-card-featured lg:col-span-1">
          <p class="eyebrow eyebrow-muted mb-3">Current plan</p>
          <h2 data-plan-name class="text-[28px] font-semibold text-[#f7f8f8]">—</h2>
          <p data-plan-price class="mt-1 font-mono text-[13px] text-[#55ccff]"></p>
          <p data-plan-blurb class="mt-3 text-[14px] leading-relaxed text-[#8a8f98]"></p>
          <p data-plan-status class="mt-3 hidden font-mono text-[12px] text-[#62666d]"></p>
          <div class="mt-6 flex flex-col gap-2">
            <button type="button" data-plan="starter" class="btn-primary flex h-10 items-center justify-center rounded-full px-4 text-[13px]">Upgrade to Starter — $5/mo</button>
            <button type="button" data-plan="pro" class="btn-ghost flex h-10 items-center justify-center rounded-full px-4 text-[13px]">Upgrade to Pro — $15/mo</button>
            <button type="button" data-action="portal" class="btn-ghost flex h-10 items-center justify-center rounded-full px-4 text-[13px]">Manage billing</button>
          </div>
          <p data-billing-note class="mt-4 hidden text-[13px] leading-relaxed text-[#8a8f98]"></p>
        </div>

        <div class="pricing-card lg:col-span-2">
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p class="eyebrow eyebrow-muted mb-3">Social credits</p>
              <p class="flex items-baseline gap-2">
                <span data-credits-balance class="font-mono text-[44px] font-medium leading-none text-[#f7f8f8]">—</span>
                <span data-credits-total class="font-mono text-[14px] text-[#62666d]"></span>
              </p>
            </div>
            <a href="/#pricing" class="nav-link h-8 px-3">Credit pricing →</a>
          </div>
          <div class="credit-meter mt-6"><div data-credits-bar class="credit-meter-fill" style="width: 0%"></div></div>
          <p data-credits-note class="mt-3 text-[13px] text-[#62666d]">Credits power premium API modes like thread briefing and JSON-LD export.</p>
          <div class="mt-6 overflow-x-auto rounded-xl border border-[#23252a]">
            <table class="docs-table">
              <thead><tr><th>Premium mode</th><th>Credits</th></tr></thead>
              <tbody>
                <tr><td><code>quote_expansion</code> / <code>obsidian_templates</code></td><td>1</td></tr>
                <tr><td><code>thread_briefing</code> / <code>context_safe_mode</code> / <code>cross_platform_parser</code></td><td>3</td></tr>
                <tr><td><code>jsonld_bulk_export</code></td><td>5</td></tr>
                <tr><td><code>author_dossier</code></td><td>10</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <section class="mt-12">
        <div class="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p class="eyebrow eyebrow-muted mb-2">API keys</p>
            <h2 class="text-[22px] font-semibold text-[#f7f8f8]">Agent access tokens</h2>
            <p class="mt-1 max-w-[520px] text-[14px] leading-relaxed text-[#8a8f98]">Use <code class="code-chip">Authorization: Bearer xmd_…</code> on <code class="code-chip">/api/convert</code> for premium modes without a browser session.</p>
          </div>
          <button type="button" data-action="create-key" class="btn-primary flex h-9 items-center rounded-full px-4 text-[13px]">Create API key</button>
        </div>
        <p data-new-key class="mb-4 hidden rounded-lg border border-[rgba(113,112,255,0.35)] bg-[rgba(113,112,255,0.07)] p-4 font-mono text-[12px] leading-relaxed text-[#d0d6e0]"></p>
        <div class="overflow-x-auto rounded-xl border border-[#23252a]">
          <table class="docs-table">
            <thead><tr><th>Key</th><th>Created</th><th>Last used</th><th></th></tr></thead>
            <tbody data-keys-body>
              <tr><td colspan="4" class="text-[#62666d]">Loading keys…</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="mt-12">
        <p class="eyebrow eyebrow-muted mb-2">Quick convert</p>
        <div class="convert-card max-w-[620px] !p-6">
          <form data-convert-form class="flex flex-col gap-3 sm:flex-row">
            <label for="x-url" class="sr-only">X status URL</label>
            <input id="x-url" data-convert-input type="url" required inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://x.com/handle/status/…" class="convert-input" />
            <button type="submit" class="btn-ghost flex h-[42px] shrink-0 items-center justify-center rounded-full px-4 text-[13px]">Get Markdown</button>
          </form>
          <p data-convert-error class="mt-3 hidden text-[13px] text-[#ff6b6b]"></p>
        </div>
      </section>
    </div>
  </main>
</div>
`

void main()
setupMaintenanceNotice()

async function main() {
  const clerk = await loadClerk()

  if (!clerk) {
    showState('not-configured')
    return
  }

  const render = () => {
    if (!clerk.user) {
      showState('signed-out')
      return
    }
    showState('ready')
    mountChrome(clerk)
    void hydrate(clerk)
  }

  wireStaticActions(clerk)
  render()
  clerk.addListener(render)
}

function showState(state: 'loading' | 'signed-out' | 'not-configured' | 'ready') {
  app.querySelectorAll<HTMLElement>('.dash-state').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.state !== state)
  })
}

let chromeMounted = false
function mountChrome(clerk: ClerkInstance) {
  const userButton = app.querySelector<HTMLDivElement>('[data-user-button]')
  const signOut = app.querySelector<HTMLElement>('[data-action="sign-out"]')
  if (userButton && !chromeMounted) {
    userButton.classList.remove('hidden')
    clerk.mountUserButton(userButton, { showName: false })
    chromeMounted = true
  }
  signOut?.classList.remove('hidden')

  const name = clerk.user?.fullName ?? clerk.user?.username ?? null
  const email = clerk.user?.primaryEmailAddress?.emailAddress ?? null
  const greeting = app.querySelector<HTMLElement>('[data-greeting]')
  const identity = app.querySelector<HTMLElement>('[data-identity]')
  if (greeting) greeting.textContent = name ? `Welcome back, ${name.split(' ')[0]}` : 'Dashboard'
  if (identity) identity.textContent = email ?? ''
}

function wireStaticActions(clerk: ClerkInstance) {
  app.querySelector('[data-action="sign-in"]')?.addEventListener('click', () => {
    void clerk.redirectToSignIn({ forceRedirectUrl: window.location.href })
  })
  app.querySelector('[data-action="sign-up"]')?.addEventListener('click', () => {
    void clerk.redirectToSignUp({ forceRedirectUrl: window.location.href })
  })
  app.querySelector('[data-action="sign-out"]')?.addEventListener('click', () => {
    void clerk.signOut().then(() => { window.location.href = '/' })
  })

  app.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach((button) => {
    button.addEventListener('click', () => void withBusy(button, async () => {
      const { ok, payload } = await fetchWithClerkToken(clerk, `/api/billing?plan=${encodeURIComponent(button.dataset.plan!)}`, { method: 'POST' })
      if (!ok || typeof payload.url !== 'string') throw new Error(String(payload.error ?? 'Checkout unavailable'))
      window.location.href = payload.url
    }))
  })

  const portal = app.querySelector<HTMLButtonElement>('[data-action="portal"]')
  portal?.addEventListener('click', () => void withBusy(portal, async () => {
    const { ok, payload } = await fetchWithClerkToken(clerk, '/api/billing?action=portal', { method: 'POST' })
    if (!ok || typeof payload.url !== 'string') throw new Error(String(payload.error ?? 'Portal unavailable'))
    window.location.href = payload.url
  }))

  const createKey = app.querySelector<HTMLButtonElement>('[data-action="create-key"]')
  createKey?.addEventListener('click', () => void withBusy(createKey, async () => {
    const { ok, payload } = await fetchWithClerkToken(clerk, '/api/api-keys', { method: 'POST' })
    if (!ok || typeof payload.apiKey !== 'string') throw new Error(String(payload.error ?? 'Key creation failed'))
    const banner = app.querySelector<HTMLElement>('[data-new-key]')
    if (banner) {
      banner.classList.remove('hidden')
      banner.textContent = `Copy this key now — it will not be shown again:\n${payload.apiKey}`
    }
    await loadKeys(clerk)
  }))

  const form = app.querySelector<HTMLFormElement>('[data-convert-form]')
  const input = app.querySelector<HTMLInputElement>('[data-convert-input]')
  const convertError = app.querySelector<HTMLElement>('[data-convert-error]')
  form?.addEventListener('submit', (e) => {
    e.preventDefault()
    const raw = input?.value.trim()
    if (!raw) return
    const path = statusPathFromUrl(raw)
    if (!path) {
      if (convertError) {
        convertError.classList.remove('hidden')
        convertError.textContent = 'Enter a public X/Twitter status URL (for example https://x.com/handle/status/123).'
      }
      return
    }
    convertError?.classList.add('hidden')
    window.open(`${path}?thread=full`, '_blank', 'noopener,noreferrer')
  })
}

async function hydrate(clerk: ClerkInstance) {
  await Promise.all([loadAccount(clerk), loadKeys(clerk)])
}

async function loadAccount(clerk: ClerkInstance) {
  const planName = app.querySelector<HTMLElement>('[data-plan-name]')
  const planPrice = app.querySelector<HTMLElement>('[data-plan-price]')
  const planBlurb = app.querySelector<HTMLElement>('[data-plan-blurb]')
  const planStatus = app.querySelector<HTMLElement>('[data-plan-status]')
  const billingNote = app.querySelector<HTMLElement>('[data-billing-note]')
  const balanceEl = app.querySelector<HTMLElement>('[data-credits-balance]')
  const totalEl = app.querySelector<HTMLElement>('[data-credits-total]')
  const barEl = app.querySelector<HTMLElement>('[data-credits-bar]')
  const noteEl = app.querySelector<HTMLElement>('[data-credits-note]')

  try {
    const { ok, payload } = await fetchWithClerkToken(clerk, '/api/account')
    if (!ok) throw new Error(String((payload as AccountPayload & { error?: string }).error ?? 'Account unavailable'))
    const account = payload as AccountPayload

    const planId = account.plan?.id ?? 'free'
    const known = PLAN_DETAILS[planId] ?? null
    if (planName) planName.textContent = known?.label ?? account.plan?.name ?? 'Free'
    if (planPrice) planPrice.textContent = known?.price ?? ''
    if (planBlurb) planBlurb.textContent = known?.blurb ?? 'Anonymous conversion stays free. Upgrade for social credits.'
    if (planStatus && account.plan?.status) {
      planStatus.classList.remove('hidden')
      planStatus.textContent = `status: ${account.plan.status}`
    }

    app.querySelectorAll<HTMLButtonElement>('[data-plan]').forEach((button) => {
      if (button.dataset.plan === planId) {
        button.disabled = true
        button.textContent = `Current plan — ${known?.label ?? planId}`
      }
    })

    if (account.billingError && billingNote) {
      billingNote.classList.remove('hidden')
      billingNote.textContent = `Billing data unavailable: ${account.billingError.message}`
    }

    const balance = account.credits?.balance
    const total = account.credits?.includedUsage
    if (balanceEl) balanceEl.textContent = typeof balance === 'number' ? String(balance) : '0'
    if (totalEl && typeof total === 'number') totalEl.textContent = `/ ${total} this period`
    if (barEl && typeof balance === 'number' && typeof total === 'number' && total > 0) {
      barEl.style.width = `${Math.max(0, Math.min(100, (balance / total) * 100))}%`
    }
    if (noteEl && account.credits == null) {
      noteEl.textContent = 'No credit balance yet — upgrade to Starter or Pro to receive monthly social credits.'
    }
  } catch (error) {
    if (planName) planName.textContent = 'Unavailable'
    if (planBlurb) planBlurb.textContent = error instanceof Error ? error.message : 'Could not load billing data.'
  }
}

async function loadKeys(clerk: ClerkInstance) {
  const body = app.querySelector<HTMLElement>('[data-keys-body]')
  if (!body) return
  try {
    const { ok, payload } = await fetchWithClerkToken(clerk, '/api/api-keys')
    if (!ok) throw new Error(String(payload.error ?? 'Could not load keys'))
    const keys = (Array.isArray(payload.keys) ? payload.keys : []) as ApiKeyRecord[]
    const active = keys.filter((key) => !key.revokedAt)
    if (active.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="text-[#62666d]">No API keys yet. Create one to use premium modes from scripts and agents.</td></tr>'
      return
    }
    body.innerHTML = active.map((key) => `
      <tr>
        <td><code>${escapeHtml(key.tokenPreview)}</code>${key.label ? ` <span class="text-[#62666d]">${escapeHtml(key.label)}</span>` : ''}</td>
        <td class="font-mono text-[12px]">${formatDate(key.createdAt)}</td>
        <td class="font-mono text-[12px]">${key.lastUsedAt ? formatDate(key.lastUsedAt) : '—'}</td>
        <td><button type="button" data-revoke="${escapeHtml(key.keyHash)}" class="btn-ghost h-7 rounded-full px-3 text-[12px]">Revoke</button></td>
      </tr>
    `).join('')
    body.querySelectorAll<HTMLButtonElement>('[data-revoke]').forEach((button) => {
      button.addEventListener('click', () => void withBusy(button, async () => {
        const { ok: revoked, payload: result } = await fetchWithClerkToken(
          clerk,
          `/api/api-keys?keyHash=${encodeURIComponent(button.dataset.revoke!)}`,
          { method: 'DELETE' },
        )
        if (!revoked) throw new Error(String(result.error ?? 'Revoke failed'))
        await loadKeys(clerk)
      }))
    })
  } catch (error) {
    body.innerHTML = `<tr><td colspan="4" class="text-[#62666d]">${escapeHtml(error instanceof Error ? error.message : 'Could not load keys')}</td></tr>`
  }
}

async function withBusy(button: HTMLButtonElement, run: () => Promise<void>) {
  const original = button.textContent
  button.disabled = true
  button.textContent = 'Working…'
  try {
    await run()
    button.textContent = original
    button.disabled = false
  } catch (error) {
    button.textContent = error instanceof Error ? error.message : 'Request failed'
    setTimeout(() => {
      button.textContent = original
      button.disabled = false
    }, 2400)
  }
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] ?? char
  ))
}
