import { captureLandingEvent } from './posthog'
import { loadWebAnalytics, whenUseful } from './deferred'
import { setupLinkPrefetch, setupMobileMenu, setupTheme } from './chrome-setup'

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

  // The hero card mirrors the converter: the path being typed, on the
  // mdfromx.com host. Nothing is fetched; an unusable URL shows the example.
  const cardPath = root.querySelector<HTMLElement>('[data-card-path]')
  if (cardPath) {
    const example = cardPath.textContent
    form.addEventListener('input', () => {
      const path = statusPathFromUrl(input.value) ?? example
      if (path === cardPath.textContent) return
      cardPath.textContent = path
      if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
        cardPath.animate({ opacity: [0.35, 1] }, { duration: 260, easing: 'ease-out' })
      }
    })
  }

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
  // The "what comes through" panels are stacked in the markup; the tabs are an
  // enhancement in their own small chunk, kept out of the first render.
  void import('./tabs').then(({ setupTabs }) => setupTabs(app)).catch(() => {})
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
    void import('./pointer').then(({ setupPointer }) => setupPointer(app)).catch(() => {})
  }
  // The light running round the converter is gradients.sh's Border Beam; the
  // form reads the same without it, so it waits for the deferred bundles too.
  whenUseful(() =>
    Promise.all([import('./gradients-pro/border-beam'), import('./gradients-pro/green')]).then(([{ borderBeam }, { BEAM }]) => {
      const form = app.querySelector<HTMLElement>('[data-beam]')
      if (form) borderBeam(form, { palette: BEAM, duration: 9, length: 0.3, beams: 2 })
    }),
  )
  // Every live gradient already has a CSS stand-in painted, so the engine is
  // optional and waits with the other deferred bundles instead of competing with them.
  whenUseful(() => import('./gradient-canvas').then(({ setupGradients }) => setupGradients(app)))
  if (matchMedia('(prefers-reduced-motion: no-preference)').matches) {
    void import('./motion').then(({ setupMotion }) => setupMotion(app)).catch(() => {
      // Optional motion must not stop the already-readable page or its controls.
    })
  }
}

void enhanceLanding()
