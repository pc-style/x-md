import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

function splitWords(el: HTMLElement) {
  const text = (el.textContent ?? '').trim()
  const nodes: (string | HTMLSpanElement)[] = []
  for (const word of text.split(/\s+/)) {
    const span = document.createElement('span')
    span.className = 'reveal-word'
    span.textContent = word
    if (nodes.length) nodes.push(' ')
    nodes.push(span)
  }
  el.replaceChildren(...nodes)
}

export function setupMotion(root: HTMLElement) {
  const scrubEl = root.querySelector<HTMLElement>('[data-scrub-text]')
  if (scrubEl && scrubEl.getBoundingClientRect().top >= window.innerHeight) splitWords(scrubEl)

  const mm = gsap.matchMedia()

  mm.add('(prefers-reduced-motion: reduce)', () => {
    root
      .querySelectorAll<HTMLElement>('.reveal-word')
      .forEach((w) => (w.style.opacity = '1'))
  })

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // The hero is already readable while this optional chunk downloads. Keep
    // its entrance transforms in the GSAP context without fading visible text.
    if (root.querySelector('[data-hero-stagger]')) {
      gsap.from('[data-hero-stagger] > *', {
        y: 26,
        duration: 0.9,
        ease: 'power3.out',
        stagger: 0.09,
      })
    }
    if (root.querySelector('[data-hero-card]')) {
      gsap.from('[data-hero-card]', {
        y: 48,
        rotate: 6,
        duration: 1.1,
        ease: 'power3.out',
        delay: 0.3,
      })
    }
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
      // A late chunk or an anchor visit must not hide content already on screen.
      if (el.getBoundingClientRect().top < window.innerHeight) return
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
}
