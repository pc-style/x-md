import { captureLandingEvent } from './posthog'
import { loadWebAnalytics, whenUseful } from './deferred'
import { setupLinkPrefetch, setupMobileMenu, setupTheme } from './chrome'

// Vercel Web Analytics for the landing page (docs pages are a separate static
// build). Off the critical path: it lands after load, on first intent, or when
// the page is hidden.
whenUseful(loadWebAnalytics)

const app = document.querySelector<HTMLDivElement>('#app')!

const HOSTED_HOSTS = new Set([
  'x.pcstyle.dev',
  'mdfromx.com',
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
    // The versioned route, not the deprecated /api/convert alias: the page
    // should not send its own traffic somewhere it tells everyone else to leave.
    const target = path
      ? `${path}?thread=full`
      : `/api/v1/posts?url=${encodeURIComponent(raw)}&thread=full`
    captureLandingEvent('conversion_requested')
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
        captureLandingEvent('skill_install_command_copied')
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

// The markup is pre-rendered into index.html at build time so crawlers and
// agents see the full page without running JavaScript. Only render here when
// that pre-render is missing (dev servers that skip the transform).
async function enhanceLanding() {
  if (!app.firstElementChild) {
    const { landingHtml } = await import('./landing')
    app.innerHTML = landingHtml()
  }

  setupConvertForm(app)
  setupMobileMenu(app)
  setupTheme(app)
  setupLinkPrefetch(app)
  setupCopyButtons(app)
  setupAccordion(app)
  if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
    void import('./motion').then(({ setupMotion }) => setupMotion(app)).catch(() => {
      // Optional motion must not stop the already-readable page or its controls.
    })
  }
}

void enhanceLanding()
