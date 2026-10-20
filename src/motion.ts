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

/**
 * What x.com sends instead of the post, for the #how pane's scroll-by:
 * plausible markup from a fixed seed. Decorative, and never shown as output.
 */
function markupRain(): string {
  let seed = 20528
  const id = () => (seed = (seed * 48271) % 2147483647).toString(36).slice(-6)
  const pieces = [
    () => `<div class="css-175oi2r r-${id()} r-${id()} r-${id()}">`,
    () => `<script nonce="${id()}${id()}">window.__SCRIPTS_LOADED__={"main":false};</script>`,
    () => `<link rel="preload" as="script" crossorigin="anonymous" href="https://abs.twimg.com/responsive-web/client-web/vendor.${id()}.js"/>`,
    () => `<style>.r-${id()}{flex-shrink:0}.r-${id()}{display:flex}.r-${id()}{min-height:0px}</style>`,
    () => `</div><div dir="ltr" class="css-146c3p1 r-${id()}" style="color:rgb(231,233,234)">`,
    () => `<meta name="twitter-site-verification" content="${id()}${id()}"/>`,
  ]
  return Array.from({ length: 96 }, (_, i) => pieces[(i * 5 + (i >> 2)) % pieces.length]()).join('')
}

/** Runs the #how x.com pane's markup scroll-by, then lets its lines print. */
function rain(pane: HTMLElement) {
  const card = pane.parentElement
  if (!card) return
  const layer = document.createElement('div')
  layer.className = 'markup-rain'
  layer.setAttribute('aria-hidden', 'true')
  const text = document.createElement('span')
  text.textContent = markupRain()
  layer.append(text)
  layer.addEventListener('animationend', (event) => {
    if (event.target === layer) layer.remove()
  })
  card.append(layer)
  pane.style.setProperty('--start', '1080ms')
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
          if ('rain' in pane.dataset) rain(pane)
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

    // The closing band ends on the product's name: once it is in view,
    // "mdfrom" is typed in front of the host, as the product is used.
    const mark = root.querySelector<HTMLElement>('.host-mark')
    if (mark && below(mark)) {
      mark.dataset.type = 'armed'
      ScrollTrigger.create({
        trigger: mark,
        start: 'top 80%',
        once: true,
        onEnter: () => {
          mark.dataset.type = 'play'
        },
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

    return () => {
      watch?.disconnect()
      for (const pane of streams) delete pane.dataset.stream
      if (mark) delete mark.dataset.type
    }
  })
}
