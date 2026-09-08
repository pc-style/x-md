import './style.css'
import { captureLandingEvent } from './posthog'
import { inject } from '@vercel/analytics'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { setupLinkPrefetch, setupMobileMenu, setupTheme } from './chrome'
import { landingHtml } from './landing'

// Vercel Web Analytics for the landing page (docs pages are a separate static build).
inject()
gsap.registerPlugin(ScrollTrigger)

const app = document.querySelector<HTMLDivElement>('#app')!

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


// The markup is pre-rendered into index.html at build time so crawlers and
// agents see the full page without running JavaScript. Only render here when
// that pre-render is missing (dev servers that skip the transform).
if (!app.firstElementChild) app.innerHTML = landingHtml()

setupConvertForm(app)
setupMobileMenu(app)
setupTheme(app)
setupLinkPrefetch(app)
setupCopyButtons(app)
setupAccordion(app)
setupMotion(app)
