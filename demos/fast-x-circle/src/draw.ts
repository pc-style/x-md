import type { Member, Person } from './rank'

export const SIZE = 1200

export interface Style {
  background: 'solid' | 'gradient'
  color1: string
  color2: string
  count: number
  nodeScale: number
  names: boolean
  ranks: boolean
  rings: boolean
}

export interface CirclePicture {
  owner: Person
  members: Member[]
  createdAt: number
}

interface Node {
  member: Member
  rank: number
  x: number
  y: number
  d: number
  ring: number
}

function rgb(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const value = match ? Number.parseInt(match[1]!, 16) : 0
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function luminance(hex: string): number {
  const channels = rgb(hex).map((channel) => {
    const unit = channel / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function layout(members: Member[], style: Style): { center: number; rings: number[]; nodes: Node[] } {
  const picked = members.slice(0, style.count)
  const raw: Array<{ x: number; y: number; d: number; ring: number }> = []
  const ringRadii: number[] = []
  let remaining = picked.length
  let outer = 100
  for (let ring = 0; remaining > 0; ring += 1) {
    let diameter = 200 * Math.max(0.3, 0.72 * 0.81 ** ring) * style.nodeScale
    let radius = outer + 9 + diameter / 2
    const capacity = Math.max(1, Math.floor((2 * Math.PI * radius) / (diameter + 9)))
    let count = Math.min(capacity, remaining)
    const leftover = remaining - count
    if (leftover > 0 && remaining >= 6 && leftover <= Math.max(2, Math.floor(0.45 * capacity))) {
      count = remaining
      diameter = Math.min(diameter, (2 * Math.PI * (outer + 9) / count - 9) / (1 - Math.PI / count))
      radius = outer + 9 + diameter / 2
    }
    const start = -Math.PI / 2 + 0.53 * ring
    for (let index = 0; index < count; index += 1) {
      const angle = start + (2 * Math.PI * index) / count
      raw.push({ x: radius * Math.cos(angle), y: radius * Math.sin(angle), d: diameter, ring })
    }
    ringRadii.push(radius)
    remaining -= count
    outer = radius + diameter / 2
  }
  const scale = Math.min(1.6, 542 / (outer || 100))
  return {
    center: 200 * scale,
    rings: ringRadii.map((radius) => radius * scale),
    nodes: raw.map((node, index) => ({
      member: picked[index]!,
      rank: index + 1,
      x: 600 + node.x * scale,
      y: 600 + node.y * scale,
      d: node.d * scale,
      ring: node.ring,
    })),
  }
}

function disk(ctx: CanvasRenderingContext2D, person: Person, x: number, y: number, diameter: number, image: CanvasImageSource | undefined, ink: string, font: string): void {
  const radius = diameter / 2
  ctx.save()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.closePath()
  if (image) {
    ctx.clip()
    ctx.drawImage(image, x - radius, y - radius, diameter, diameter)
  } else {
    ctx.fillStyle = rgba(ink, 0.16)
    ctx.fill()
    ctx.fillStyle = ink
    ctx.font = `800 ${Math.round(diameter * 0.42)}px ${font}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(person.handle.slice(0, 1).toUpperCase(), x, y + diameter * 0.03)
  }
  ctx.restore()
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.lineWidth = Math.max(2.5, diameter * 0.03)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)'
  ctx.stroke()
}

function badge(ctx: CanvasRenderingContext2D, x: number, y: number, lines: Array<{ text: string; font: string; color: string }>, align: 'left' | 'right'): void {
  const gaps = [30, 24]
  const width = Math.max(...lines.map((line) => (ctx.font = line.font, ctx.measureText(line.text).width))) + 36
  const height = lines.reduce((sum, _line, index) => sum + (gaps[index] ?? 0), 0) + 26 - 6
  const left = align === 'left' ? x : x - width
  const top = y - height
  ctx.beginPath()
  ctx.roundRect(left, top, width, height, 12)
  ctx.fillStyle = 'rgba(0, 18, 59, 0.86)'
  ctx.fill()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  let cursor = top + 13 + 20
  lines.forEach((line, index) => {
    ctx.font = line.font
    ctx.fillStyle = line.color
    ctx.fillText(line.text, left + 18, cursor)
    cursor += gaps[index + 1] ?? 0
  })
}

function ellipsis(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text
  let next = text
  while (next.length > 1 && ctx.measureText(`${next}…`).width > width) next = next.slice(0, -1)
  return `${next}…`
}

export function draw(canvas: HTMLCanvasElement, circle: CirclePicture, style: Style, avatars: Map<string, CanvasImageSource>): void {
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const font = getComputedStyle(document.body).fontFamily || 'Figtree, sans-serif'
  const ink = (style.background === 'gradient' ? (luminance(style.color1) + luminance(style.color2)) / 2 : luminance(style.color1)) > 0.36 ? '#00123B' : '#FEF9F4'
  if (style.background === 'gradient') {
    const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE)
    gradient.addColorStop(0, style.color1)
    gradient.addColorStop(1, style.color2)
    ctx.fillStyle = gradient
  } else ctx.fillStyle = style.color1
  ctx.fillRect(0, 0, SIZE, SIZE)
  const placed = layout(circle.members, style)
  if (style.rings) {
    ctx.lineWidth = 2
    ctx.strokeStyle = rgba(ink, 0.18)
    for (const radius of placed.rings) {
      ctx.beginPath()
      ctx.arc(600, 600, radius, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  for (const node of placed.nodes) disk(ctx, node.member, node.x, node.y, node.d, node.member.avatar ? avatars.get(node.member.avatar) : undefined, ink, font)
  if (style.names) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const node of placed.nodes) {
      if (node.d < 44) continue
      const size = Math.max(11, Math.min(19, node.d * 0.13))
      ctx.font = `700 ${size}px ${font}`
      const label = ellipsis(ctx, `@${node.member.handle}`, node.d * 0.84)
      const width = ctx.measureText(label).width + size * 0.9
      const height = size * 1.55
      const y = node.y + node.d * 0.3
      ctx.beginPath()
      ctx.roundRect(node.x - width / 2, y - height / 2, width, height, height / 2.4)
      ctx.fillStyle = 'rgba(0, 18, 59, 0.8)'
      ctx.fill()
      ctx.fillStyle = '#FEF9F4'
      ctx.fillText(label, node.x, y + 1)
    }
  }
  if (style.ranks) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const node of placed.nodes) {
      const radius = Math.max(12, node.d * 0.15)
      const x = node.x + node.d * 0.35
      const y = node.y - node.d * 0.35
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fillStyle = '#FEDE95'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = '#00123B'
      ctx.stroke()
      ctx.fillStyle = '#00123B'
      ctx.font = `800 ${Math.round(radius * (node.rank > 9 ? 0.95 : 1.15))}px ${font}`
      ctx.fillText(String(node.rank), x, y + 1)
    }
  }
  disk(ctx, circle.owner, 600, 600, placed.center, circle.owner.avatar ? avatars.get(circle.owner.avatar) : undefined, ink, font)
  const date = new Date(circle.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  badge(ctx, 30, 1170, [
    { text: `@${circle.owner.handle}`, font: `800 24px ${font}`, color: '#FEF9F4' },
    { text: `X circle, ${date}`, font: `600 17px ${font}`, color: 'rgba(254, 249, 244, 0.78)' },
  ], 'left')
  badge(ctx, 1170, 1170, [{ text: 'fast x circle', font: `700 19px ${font}`, color: '#FEF9F4' }], 'right')
}

export function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    } catch {
      resolve(null)
    }
  })
}
