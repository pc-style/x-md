import type { Member, Person } from './core.ts'

export const SIZE = 1200

export interface Style {
  background: 'gradient' | 'solid'
  color1: string
  color2: string
  count: number
  nodeScale: number
  names: boolean
  ranks: boolean
  rings: boolean
}

export const DEFAULT_STYLE: Style = {
  background: 'gradient',
  color1: '#00123B',
  color2: '#26286B',
  count: 50,
  nodeScale: 1,
  names: false,
  ranks: false,
  rings: false,
}

export interface Circle {
  owner: Person
  createdAt: number
  members: Member[]
}

interface Node { member: Member; rank: number; x: number; y: number; d: number; ring: number }

/**
 * Rings packed outward from a 200px centre: each ring's photos are 81% of the
 * previous ring's, a nearly-full last ring is squeezed into the one before it,
 * and the whole picture is scaled to fit the 1200px square.
 */
export function layout(members: Member[], style: Style): { center: number; nodes: Node[]; rings: number[] } {
  const shown = members.slice(0, style.count)
  const raw: { x: number; y: number; d: number; ring: number }[] = []
  const rings: number[] = []
  let left = shown.length
  let edge = 100
  for (let ring = 0; left > 0; ring++) {
    let d = 200 * Math.max(0.3, 0.72 * Math.pow(0.81, ring)) * style.nodeScale
    let radius = edge + 9 + d / 2
    const fits = Math.max(1, Math.floor((2 * Math.PI * radius) / (d + 9)))
    let count = Math.min(fits, left)
    const rest = left - count
    if (rest > 0 && left >= 6 && rest <= Math.max(2, Math.floor(0.45 * fits))) {
      count = left
      d = Math.min(d, ((2 * Math.PI * (edge + 9)) / count - 9) / (1 - Math.PI / count))
      radius = edge + 9 + d / 2
    }
    const start = -Math.PI / 2 + 0.53 * ring
    for (let i = 0; i < count; i++) {
      const angle = start + (2 * Math.PI * i) / count
      raw.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle), d, ring })
    }
    rings.push(radius)
    left -= count
    edge = radius + d / 2
  }
  const scale = Math.min(1.6, 542 / edge)
  return {
    center: 200 * scale,
    rings: rings.map((r) => r * scale),
    nodes: raw.map((n, i) => ({ member: shown[i], rank: i + 1, x: 600 + n.x * scale, y: 600 + n.y * scale, d: n.d * scale, ring: n.ring })),
  }
}

function rgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const value = match ? parseInt(match[1], 16) : 0
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const rgba = (hex: string, alpha: number): string => { const [r, g, b] = rgb(hex); return `rgba(${r}, ${g}, ${b}, ${alpha})` }

function photo(ctx: CanvasRenderingContext2D, who: Person, x: number, y: number, d: number, img: HTMLImageElement | undefined, ink: string, font: string) {
  const r = d / 2
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, 2 * Math.PI)
  ctx.closePath()
  if (img) {
    ctx.clip()
    ctx.drawImage(img, x - r, y - r, d, d)
  } else {
    ctx.fillStyle = rgba(ink, 0.16)
    ctx.fill()
    ctx.fillStyle = ink
    ctx.font = `800 ${Math.round(0.42 * d)}px ${font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(who.handle.slice(0, 1).toUpperCase(), x, y + 0.03 * d)
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(x, y, r, 0, 2 * Math.PI)
  ctx.lineWidth = Math.max(2.5, 0.03 * d)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.stroke()
}

function tag(ctx: CanvasRenderingContext2D, x: number, bottom: number, lines: { text: string; font: string; color: string }[], side: 'left' | 'right') {
  const steps = [30, 24]
  const width = Math.max(...lines.map((l) => { ctx.font = l.font; return ctx.measureText(l.text).width })) + 36
  const height = lines.reduce((sum, _l, i) => sum + steps[i], 0) + 20
  const left = side === 'left' ? x : x - width
  const top = bottom - height
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') ctx.roundRect(left, top, width, height, 12)
  else ctx.rect(left, top, width, height)
  ctx.fillStyle = 'rgba(0, 18, 59, 0.86)'
  ctx.fill()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  let y = top + 33
  lines.forEach((line, i) => {
    ctx.font = line.font
    ctx.fillStyle = line.color
    ctx.fillText(line.text, left + 18, y)
    y += steps[i + 1] ?? 0
  })
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text
  let cut = text
  while (cut.length > 1 && ctx.measureText(cut + '…').width > max) cut = cut.slice(0, -1)
  return cut + '…'
}

export function draw(canvas: HTMLCanvasElement, circle: Circle, style: Style, images: Map<string, HTMLImageElement>, footer: string) {
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const font = getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif'
  const bright = (style.background === 'gradient' ? (luminance(style.color1) + luminance(style.color2)) / 2 : luminance(style.color1)) > 0.36
  const ink = bright ? '#00123B' : '#FEF9F4'
  if (style.background === 'gradient') {
    const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE)
    gradient.addColorStop(0, style.color1)
    gradient.addColorStop(1, style.color2)
    ctx.fillStyle = gradient
  } else {
    ctx.fillStyle = style.color1
  }
  ctx.fillRect(0, 0, SIZE, SIZE)

  const { center, nodes, rings } = layout(circle.members, style)
  if (style.rings) {
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(ink, 0.18)
    for (const r of rings) { ctx.beginPath(); ctx.arc(600, 600, r, 0, 2 * Math.PI); ctx.stroke() }
  }
  for (const node of nodes) photo(ctx, node.member, node.x, node.y, node.d, node.member.avatar ? images.get(node.member.avatar) : undefined, ink, font)

  if (style.names) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const node of nodes) {
      if (node.d < 44) continue
      const size = Math.max(11, Math.min(19, 0.13 * node.d))
      ctx.font = `700 ${size}px ${font}`
      const label = fit(ctx, '@' + node.member.handle, 0.84 * node.d)
      const w = ctx.measureText(label).width + 0.9 * size
      const h = 1.55 * size
      const y = node.y + 0.3 * node.d
      ctx.beginPath()
      if (typeof ctx.roundRect === 'function') ctx.roundRect(node.x - w / 2, y - h / 2, w, h, h / 2.4)
      else ctx.rect(node.x - w / 2, y - h / 2, w, h)
      ctx.fillStyle = 'rgba(0, 18, 59, 0.8)'
      ctx.fill()
      ctx.fillStyle = '#FEF9F4'
      ctx.fillText(label, node.x, y + 1)
    }
  }
  if (style.ranks) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const node of nodes) {
      const r = Math.max(12, 0.15 * node.d)
      const x = node.x + 0.35 * node.d
      const y = node.y - 0.35 * node.d
      ctx.beginPath()
      ctx.arc(x, y, r, 0, 2 * Math.PI)
      ctx.fillStyle = '#FEDE95'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#00123B'
      ctx.stroke()
      ctx.fillStyle = '#00123B'
      ctx.font = `800 ${Math.round(r * (node.rank > 9 ? 0.95 : 1.15))}px ${font}`
      ctx.fillText(String(node.rank), x, y + 1)
    }
  }
  photo(ctx, circle.owner, 600, 600, center, circle.owner.avatar ? images.get(circle.owner.avatar) : undefined, ink, font)
  const date = new Date(circle.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  tag(ctx, 30, 1170, [
    { text: '@' + circle.owner.handle, font: `800 24px ${font}`, color: '#FEF9F4' },
    { text: `X circle, ${date}`, font: `600 17px ${font}`, color: 'rgba(254, 249, 244, 0.78)' },
  ], 'left')
  tag(ctx, 1170, 1170, [{ text: footer, font: `700 19px ${font}`, color: '#FEF9F4' }], 'right')
}

const cache = new Map<string, Promise<HTMLImageElement | null>>()

export function loadImage(url: string): Promise<HTMLImageElement | null> {
  let pending = cache.get(url)
  if (!pending) {
    pending = new Promise((resolve) => {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.decoding = 'async'
      img.onload = () => resolve(img)
      img.onerror = () => resolve(null)
      img.src = url
    })
    cache.set(url, pending)
  }
  return pending
}

export function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try { canvas.toBlob((blob) => resolve(blob), 'image/png') } catch { resolve(null) }
  })
}
