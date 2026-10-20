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
  // A late chunk or an anchor visit must not hide content already on screen:
  // only what is still below the fold gets a reveal.
  const below = (el: Element) => el.getBoundingClientRect().top >= window.innerHeight
  const scrubEl = root.querySelector<HTMLElement>('[data-scrub-text]')
  if (scrubEl && below(scrubEl)) splitWords(scrubEl)
  const streams = gsap.utils.toArray<HTMLElement>('[data-stream-view]').filter(below)

  const mm = gsap.matchMedia()

  mm.add('(prefers-reduced-motion: reduce)', () => {
    root
      .querySelectorAll<HTMLElement>('.reveal-word')
      .forEach((w) => (w.style.opacity = '1'))
  })

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // The #how panes print their output as they arrive: the x.com markup dumps
    // dim and "JavaScript is not available." lands last, while the Markdown
    // streams in line by line. The animation is the hero card's `.stream` CSS.
    for (const pane of streams) {
      pane.dataset.stream = 'armed'
      ScrollTrigger.create({
        trigger: pane,
        start: 'top 85%',
        once: true,
        onEnter: () => {
          pane.dataset.stream = 'play'
        },
      })
    }

    // The closing horizon rises a little as the band arrives, answering the
    // hero's. Decorative and transform-only, so it may start mid-way.
    const closing = root.querySelector<HTMLElement>('.orbit-band-closing')
    const sky = closing?.querySelector<HTMLElement>('.orbit-sky')
    let watch: ResizeObserver | undefined
    if (closing && sky) {
      gsap.fromTo(sky, { yPercent: 14 }, {
        yPercent: 0,
        ease: 'none',
        // Keyed to the band's bottom: the arc sits low in it, so this is the
        // stretch of scrolling in which the arc itself comes into view.
        scrollTrigger: { trigger: closing, start: 'bottom 125%', end: 'bottom bottom', scrub: 0.4 },
      })
      // The sections above it render lazily (`content-visibility: auto`) and
      // change the page height when they do; keep the trigger's positions true.
      let pending = 0
      watch = new ResizeObserver(() => {
        window.clearTimeout(pending)
        pending = window.setTimeout(() => ScrollTrigger.refresh(), 200)
      })
      watch.observe(root)
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

    return () => {
      watch?.disconnect()
      for (const pane of streams) delete pane.dataset.stream
    }
  })
}
