/**
 * Touches for a mouse or trackpad, in a chunk that touch screens never load
 * (`main.ts`): a light that follows the pointer across the cards, and the hero
 * card's scan line following the pointer, so the post as x.com shows it and
 * its Markdown can be compared line by line.
 */
export function setupPointer(root: HTMLElement) {
  root.addEventListener(
    'pointermove',
    (event) => {
      const card = (event.target as Element).closest<HTMLElement>('.spot')
      if (!card) return
      const box = card.getBoundingClientRect()
      card.style.setProperty('--mx', `${event.clientX - box.left}px`)
      card.style.setProperty('--my', `${event.clientY - box.top}px`)
    },
    { passive: true },
  )

  const card = root.querySelector<HTMLElement>('.hero-demo')
  const body = card?.querySelector<HTMLElement>('.card-body')
  if (!card || !body) return
  // Markdown above the line, the post below it; the bar follows whichever
  // view has most of the card. Leaving, or pressing to select text, returns
  // the card to its Markdown.
  const show = (scan: number) => {
    body.style.setProperty('--scan', scan.toFixed(3))
    card.toggleAttribute('data-html', scan < 0.5)
  }
  const rest = () => {
    delete card.dataset.scrub
    show(1)
  }
  card.addEventListener(
    'pointermove',
    (event) => {
      if (event.buttons) return
      const box = body.getBoundingClientRect()
      // The line sits mid-way through the 2rem crossfade band (style.css).
      const band = 2 * parseFloat(getComputedStyle(document.documentElement).fontSize)
      card.dataset.scrub = ''
      show(Math.min(1, Math.max(0, (event.clientY - box.top + band / 2) / (box.height + band))))
    },
    { passive: true },
  )
  card.addEventListener('pointerleave', rest)
  card.addEventListener('pointerdown', rest)
}
