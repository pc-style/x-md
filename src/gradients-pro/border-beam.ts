// gradients.sh Pro · licensed to aSfr5hJDvmXsLCCPcmVsZdRBfRJCGrW0 (p***@duck.com) · 2026-10-21 · https://gradients.sh/license
// x-md: a vanilla port of the BorderBeam component, always running. The
// border geometry and the beam are as served; the canvas is added here, and
// the beam fades in once instead of starting at full strength.
import { DitherSurface, resolveRamp } from './dither-kit'
import type { DitherPalette } from './dither-kit'

export interface BorderBeamOptions {
  /** A ramp, faint to hot. The beam sits on a dark band, so one scheme. */
  palette: DitherPalette
  /** Seconds for one lap of the border. */
  duration?: number
  /** Length of the beam's tail as a fraction of the perimeter, 0.05-0.45. */
  length?: number
  /** 1 beam, or 2 on opposite sides. */
  beams?: 1 | 2
  /** Size of one dither cell in CSS pixels. */
  cell?: number
}

/** Length of the fade in front of the beam's head, as a fraction of the perimeter. */
const LEAD = 0.012

interface BandCell {
  /** Position along the perimeter, 0..1, clockwise from the top-left. */
  s: number
  /** Distance inward from the outer edge in CSS pixels. */
  depth: number
}

/** Where a point sits on a rounded rectangle's border. */
function locate(x: number, y: number, w: number, h: number, r: number): BandCell | null {
  const top = w - 2 * r
  const side = h - 2 * r
  const arc = (Math.PI * r) / 2
  const perimeter = 2 * top + 2 * side + 4 * arc
  const corner = (cx: number, cy: number, start: number, a0: number) => {
    const dx = x - cx
    const dy = y - cy
    const dist = Math.hypot(dx, dy)
    if (dist > r) return null
    let a = Math.atan2(dy, dx) - a0
    while (a < 0) a += Math.PI * 2
    return {
      depth: r - dist,
      s: (start + Math.min(a, Math.PI / 2) * r) / perimeter,
    }
  }
  if (x < r && y < r) return corner(r, r, 2 * top + 2 * side + 3 * arc, Math.PI)
  if (x > w - r && y < r) return corner(w - r, r, top, -Math.PI / 2)
  if (x > w - r && y > h - r) return corner(w - r, h - r, top + side + arc * 2, 0)
  if (x < r && y > h - r) return corner(r, h - r, 2 * top + side + arc * 3, Math.PI / 2)
  const edges = [
    { depth: y, s: x - r },
    { depth: w - x, s: top + arc + (y - r) },
    { depth: h - y, s: top + side + 2 * arc + (w - r - x) },
    { depth: x, s: 2 * top + side + 3 * arc + (h - r - y) },
  ]
  let best = edges[0]
  for (const edge of edges) if (best && edge.depth < best.depth) best = edge
  return best ? { depth: best.depth, s: best.s / perimeter } : null
}

/**
 * A short beam of dithered light that travels around the border of its box,
 * spilling a little light inward. Give it a radius and a border like any card.
 */
export function borderBeam(
  root: HTMLElement,
  { palette, duration = 7, length = 0.34, beams = 1, cell = 2 }: BorderBeamOptions,
): void {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  const canvas = document.createElement('canvas')
  canvas.className = 'beam-canvas'
  canvas.setAttribute('aria-hidden', 'true')
  root.prepend(canvas)
  const ramp = resolveRamp(palette, 'dark', root)
  const surface = new DitherSurface(canvas, cell)
  const tail = Math.min(Math.max(length, 0.05), 0.45)
  const glow = 18
  let band: BandCell[] = []
  let cells = new Uint32Array(0)
  let frame = 0
  let visible = true
  let level = 0
  let phase = 0.1
  let last = 0

  const layout = () => {
    const rect = root.getBoundingClientRect()
    const style = getComputedStyle(root)
    const border = Number.parseFloat(style.borderTopWidth) || 0
    // The canvas sits on the border box, so the beam rides the border line.
    const w = rect.width
    const h = rect.height
    const r = Math.min(Number.parseFloat(style.borderTopLeftRadius) || 0, w / 2, h / 2)
    canvas.style.left = `${-border}px`
    canvas.style.top = `${-border}px`
    surface.fit(w, h)
    const next: BandCell[] = []
    const indices: number[] = []
    for (let row = 0; row < surface.rows; row++) {
      for (let col = 0; col < surface.cols; col++) {
        const hit = locate((col + 0.5) * cell, (row + 0.5) * cell, w, h, r)
        if (!hit || hit.depth > glow) continue
        next.push(hit)
        indices.push(row * surface.cols + col)
      }
    }
    band = next
    cells = Uint32Array.from(indices)
  }

  const draw = (now: number) => {
    frame = 0
    const dt = last ? Math.min(64, now - last) / 1000 : 0
    last = now
    if (!reduced.matches) phase = (phase + dt / duration) % 1
    level = reduced.matches ? 1 : level + (1 - level) * Math.min(1, dt * 2)
    if (Math.abs(level - 1) < 0.01) level = 1
    surface.paintCells(ramp, cells, (k) => {
      const cellInfo = band[k]
      if (!cellInfo) return 0
      let v = 0
      for (let b = 0; b < beams; b++) {
        const head = (phase + b / beams) % 1
        let behind = head - cellInfo.s
        if (behind < -0.5) behind += 1
        if (behind > 0.5) behind -= 1
        if (behind > tail || behind < -LEAD) continue
        // A short soft lead in front of the head, a long tail behind it.
        const t = behind < 0 ? 1 + behind / LEAD : 1 - behind / tail
        v = Math.max(v, t ** 2.2)
      }
      // Full light on the border line, a dithered spill fading inward.
      const onLine = cellInfo.depth < cell * 1.5 ? 1 : 0
      const spill = Math.max(0, 1 - cellInfo.depth / glow) ** 2.2 * 0.62
      return level * v * Math.max(onLine, spill)
    })
    if (visible && !reduced.matches) frame = requestAnimationFrame(draw)
  }

  const start = () => {
    last = 0
    if (!frame) frame = requestAnimationFrame(draw)
  }

  new ResizeObserver(() => {
    layout()
    start()
  }).observe(root)
  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
    if (visible) start()
  }).observe(root)
  reduced.addEventListener('change', start)
}

void [0.12500019977228, "⁣​​​‌‌‌‌​​‌‌‌‌​‌‌‌​​‌‌​‌​⁣"];
