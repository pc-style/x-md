// gradients.sh Pro · licensed to aSfr5hJDvmXsLCCPcmVsZdRBfRJCGrW0 (p***@duck.com) · 2026-10-21 · https://gradients.sh/license
// x-md: a vanilla port of the SpotlightGrid component. The light, its easing
// and the drawing are as served; the cards are the existing `.spot` elements,
// and their canvas and ring are added here instead of rendered by React.
import { DitherSurface, falloff, readScheme, resolveRamp, subscribeScheme } from './dither-kit'
import type { ColorScheme, DitherPalette, Rgba } from './dither-kit'

export interface SpotlightGridOptions {
  /** A ramp per colour scheme, faint to hot. */
  palette: Record<ColorScheme, DitherPalette>
  /** Radius of the light in CSS pixels. */
  radius?: number
  /** 0-1. How hot the centre of the light gets. */
  intensity?: number
  /** Size of one dither cell in CSS pixels. */
  cell?: number
}

/**
 * One light under a grid of cards. It follows the pointer across the gaps,
 * dithers into each card's surface and catches each card's hairline border.
 * Keyboard focus inside a card turns the light on over that card.
 */
export function spotlightGrid(
  root: HTMLElement,
  { palette, radius = 240, intensity = 0.34, cell = 4 }: SpotlightGridOptions,
): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const cards = [...root.querySelectorAll<HTMLElement>('.spot')].map((card) => {
    const layer = document.createElement('div')
    layer.className = 'spot-light'
    layer.setAttribute('aria-hidden', 'true')
    const canvas = document.createElement('canvas')
    layer.append(canvas)
    const ring = document.createElement('div')
    ring.className = 'spot-ring'
    ring.setAttribute('aria-hidden', 'true')
    card.prepend(layer)
    card.append(ring)
    return { card, ring, surface: new DitherSurface(canvas, cell), ramp: [] as Rgba[] }
  })

  // x-md: each card takes the ramp for its own surface rather than the page's:
  // the `.bento-dark` code panes, and `.night` cards or cards in a `.night`
  // band, stay dark in the light theme. (Read from the classes, not the
  // computed background, which is mid-transition when the theme flips.) The
  // ring takes the page's accent in CSS (.spot-ring).
  const theme = () => {
    const page = readScheme()
    const ramps = {
      dark: resolveRamp(palette.dark, 'dark', root),
      light: resolveRamp(palette.light, 'light', root),
    }
    for (const entry of cards) entry.ramp = ramps[entry.card.closest('.bento-dark, .night') ? 'dark' : page]
    schedule()
  }

  const light = { level: 0, target: 0, x: 0, y: 0 }
  let frame = 0
  let last = 0

  const draw = (now: number) => {
    frame = 0
    const dt = last ? Math.min(64, now - last) : 16
    last = now
    // Ease toward the target: about 180ms in, 320ms out.
    const rate = light.target > light.level ? 0.012 : 0.007
    light.level = reduced.matches
      ? light.target
      : light.level + (light.target - light.level) * Math.min(1, dt * rate)
    if (Math.abs(light.target - light.level) < 0.01) {
      light.level = light.target
    }

    const rootRect = root.getBoundingClientRect()
    for (const { card, ring, surface, ramp } of cards) {
      const rect = card.getBoundingClientRect()
      const lx = light.x - rect.left
      const ly = light.y - rect.top
      ring.style.setProperty('--spot-x', `${lx}px`)
      ring.style.setProperty('--spot-y', `${ly}px`)
      ring.style.opacity = String(light.level)

      surface.fit(rect.width, rect.height)
      const dx = Math.max(rect.left - light.x, 0, light.x - rect.right)
      const dy = Math.max(rect.top - light.y, 0, light.y - rect.bottom)
      if (light.level === 0 || Math.hypot(dx, dy) > radius) {
        surface.clear()
        continue
      }
      const cx = lx / cell
      const cy = ly / cell
      const rc = radius / cell
      const peak = intensity * light.level
      surface.paint(
        ramp,
        (col, row) => {
          const f = falloff(Math.hypot(col + 0.5 - cx, row + 0.5 - cy), rc)
          // A long faint shoulder and a small hot core under the pointer.
          return peak * f * f + 0.32 * light.level * f ** 10
        },
        {
          // Align the Bayer grid across cards so it reads as one light.
          ox: Math.round((rect.left - rootRect.left) / cell),
          oy: Math.round((rect.top - rootRect.top) / cell),
        },
      )
    }
    if (light.level !== light.target) frame = requestAnimationFrame(draw)
  }

  // x-md: with the light off and settled there is nothing to draw, so a
  // scroll, a resize or a theme change skips the per-card layout reads.
  function schedule() {
    if (light.level === 0 && light.target === 0) return
    if (!frame) frame = requestAnimationFrame(draw)
  }

  const onMove = (event: PointerEvent) => {
    if (event.pointerType === 'touch') return
    light.x = event.clientX
    light.y = event.clientY
    light.target = 1
    schedule()
  }
  const onLeave = () => {
    light.target = 0
    schedule()
  }
  const onFocusIn = (event: FocusEvent) => {
    if (!(event.target instanceof Element)) return
    if (!event.target.matches(':focus-visible')) return
    const card = event.target.closest<HTMLElement>('.spot')
    if (!card) return
    const rect = card.getBoundingClientRect()
    light.x = rect.left + rect.width / 2
    light.y = rect.top + rect.height * 0.35
    light.target = 1
    schedule()
  }

  root.addEventListener('pointermove', onMove)
  root.addEventListener('pointerleave', onLeave)
  root.addEventListener('focusin', onFocusIn)
  root.addEventListener('focusout', onLeave)
  window.addEventListener('scroll', schedule, { passive: true })
  new ResizeObserver(schedule).observe(root)
  subscribeScheme(theme)
  theme()
}

void [0.12500065977199, "⁣​‌‌​​‌​​‌​‌​‌‌​​​‌​‌​‌‌‌⁣"];
