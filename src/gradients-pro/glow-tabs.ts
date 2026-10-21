// gradients.sh Pro · licensed to aSfr5hJDvmXsLCCPcmVsZdRBfRJCGrW0 (p***@duck.com) · 2026-10-21 · https://gradients.sh/license
// x-md: a vanilla port of the GlowTabs indicator. The tabs themselves (roles,
// keys, panels) are `tabs.ts`; this adds the sliding light under the selected
// one, drawn as served.
import { DitherSurface, readScheme, resolveRamp, subscribeScheme } from './dither-kit'
import type { ColorScheme, DitherPalette } from './dither-kit'

export interface GlowTabsOptions {
  /** A ramp per colour scheme, faint to hot. */
  palette: Record<ColorScheme, DitherPalette>
  /** Size of one dither cell in CSS pixels. */
  cell?: number
}

/** Height of the light above the line, in CSS pixels. */
const GLOW = 18

/**
 * Underline tabs where the active line is a hot edge of the palette and
 * dithered light rises from it into the tab. The indicator slides between
 * tabs. Returns the function that moves it under a tab.
 */
export function glowTabs(list: HTMLElement, { palette, cell = 2 }: GlowTabsOptions): (tab: HTMLElement) => void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const indicator = document.createElement('div')
  indicator.className = 'tab-glow'
  indicator.setAttribute('aria-hidden', 'true')
  indicator.style.height = `${GLOW + cell}px`
  const canvas = document.createElement('canvas')
  indicator.append(canvas)
  list.append(indicator)
  const surface = new DitherSurface(canvas, cell)
  let active: HTMLElement | undefined
  let placed = false

  const place = () => {
    const tab = active
    if (!tab) return
    const scheme = readScheme()
    const ramp = resolveRamp(palette[scheme], scheme, list)
    const width = tab.offsetWidth
    // On narrow screens the row scrolls; keep the active tab in view
    // without scrolling the page.
    if (tab.offsetLeft < list.scrollLeft) {
      list.scrollLeft = tab.offsetLeft
    } else if (tab.offsetLeft + width > list.scrollLeft + list.clientWidth) {
      list.scrollLeft = tab.offsetLeft + width - list.clientWidth
    }
    indicator.style.transition =
      reduced.matches || !placed
        ? 'none'
        : 'translate 240ms cubic-bezier(0.23, 1, 0.32, 1), width 240ms cubic-bezier(0.23, 1, 0.32, 1)'
    indicator.style.translate = `${tab.offsetLeft}px 0`
    indicator.style.width = `${width}px`
    placed = true
    surface.fit(width, GLOW + cell)
    canvas.style.width = '100%'
    const rows = surface.rows
    const cols = surface.cols
    surface.paint(ramp, (col, row) => {
      const fromBottom = rows - 1 - row
      const x = (col + 0.5) / cols
      // Fade toward both ends so the light sits under the label.
      const across = Math.sin(Math.PI * x) ** 0.6
      if (fromBottom === 0) return Math.min(1, 1.15 * across ** 0.35)
      const rise = 1 - fromBottom / rows
      return 0.5 * across * rise ** 2.2
    })
  }

  // x-md: the selected tab is watched too, since a webfont arriving after
  // setup changes its width without changing the list's.
  const resize = new ResizeObserver(place)
  resize.observe(list)
  subscribeScheme(() => {
    placed = false
    place()
  })
  return (tab) => {
    if (active && active !== tab) resize.unobserve(active)
    active = tab
    resize.observe(tab)
    place()
  }
}

void [0.12500107115361, "⁣‌​‌​​​‌‌​‌‌‌​​​‌‌‌‌‌​​​​⁣"];
