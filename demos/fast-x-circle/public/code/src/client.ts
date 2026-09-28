import { draw, toPngBlob, type Style } from './draw'
import type { Member, Person } from './rank'

interface CircleSnapshot {
  partial: boolean
  owner: Person
  members: Member[]
  postsRead: number
  oldest: number | null
  mentionsRead: boolean
  createdAt: number
}

const STEPS = [
  { id: 'posts', label: 'Reading recent posts and mentions' },
  { id: 'people', label: 'Scoring people and fetching their photos' },
]

const PRESETS = [
  { name: 'Navy', background: 'gradient' as const, color1: '#00123B', color2: '#26286B' },
  { name: 'Purple', background: 'gradient' as const, color1: '#996CFC', color2: '#5946AB' },
  { name: 'Gold', background: 'gradient' as const, color1: '#FEDE95', color2: '#FEF9F4' },
  { name: 'Cream', background: 'solid' as const, color1: '#FEF9F4', color2: '#F3EDFF' },
  { name: 'Grey', background: 'solid' as const, color1: '#B2B4BC', color2: '#DBD8DA' },
  { name: 'Night', background: 'solid' as const, color1: '#00123B', color2: '#26286B' },
]

const ERRORS: Record<string, string> = {
  bad_handle: 'That is not an X username. It is 1 to 15 letters, numbers or underscores.',
  not_found: 'There is no X account with that username. Check the spelling and try again.',
  private: 'This account is private, so its posts cannot be read. Fast X Circle works on public accounts only.',
  empty: 'This account has no recent public posts to read, so there is no one to put in the circle yet.',
  no_one: 'The recent posts of this account do not reply to, quote, repost or mention anyone, so the circle would be empty.',
  unavailable: 'X posts could not be read right now. Wait a minute and try again.',
  rate_limited: 'Too many circles at once. Wait a minute and try again.',
  missing_key: 'The reader is not configured right now.',
}

function noun(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

function cleanHandle(value: string): string | null {
  let text = value.trim()
  const match = /(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})/i.exec(text)
  if (match?.[1]) text = match[1]
  text = text.replace(/^@+/, '')
  return /^[A-Za-z0-9_]{1,15}$/.test(text) ? text : null
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const form = document.querySelector<HTMLFormElement>('#xc-form')!
const input = document.querySelector<HTMLInputElement>('#xc-handle')!
const go = document.querySelector<HTMLButtonElement>('#xc-go')!
const status = document.querySelector<HTMLDivElement>('#xc-status')!
const error = document.querySelector<HTMLParagraphElement>('#xc-error')!
const result = document.querySelector<HTMLElement>('#xc-result')!
const canvas = document.querySelector<HTMLCanvasElement>('#xc-canvas')!
const basis = document.querySelector<HTMLParagraphElement>('#xc-basis')!
const title = document.querySelector<HTMLHeadingElement>('#xc-result-title')!
const people = document.querySelector<HTMLOListElement>('#xc-people')!
const swatches = document.querySelector<HTMLDivElement>('#xc-swatches')!
const download = document.querySelector<HTMLButtonElement>('#xc-download')!

let style: Style = { background: 'gradient', color1: '#00123B', color2: '#26286B', count: 50, nodeScale: 1, names: false, ranks: false, rings: false }
let snapshot: CircleSnapshot | null = null
let hidden = new Set<string>()
let abort: AbortController | null = null
let startedAt = 0
let clockTimer = 0
const images = new Map<string, CanvasImageSource>()
const loading = new Map<string, Promise<void>>()

function visibleMembers(): Member[] {
  return (snapshot?.members ?? []).filter((member) => !hidden.has(member.handle.toLowerCase()))
}

function shownMembers(): Member[] {
  return visibleMembers().slice(0, style.count)
}

function paint(): void {
  if (!snapshot) return
  draw(canvas, { owner: snapshot.owner, members: shownMembers(), createdAt: snapshot.createdAt }, style, images)
  const count = Math.min(style.count, visibleMembers().length)
  canvas.setAttribute('aria-label', `Interaction circle of @${snapshot.owner.handle}`)
  result.dataset.people = String(count)
  result.dataset.postsRead = String(snapshot.postsRead)
}

function ensureImage(url: string | null): void {
  if (!url || images.has(url) || loading.has(url)) return
  const job = new Promise<void>((resolve) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.referrerPolicy = 'no-referrer'
    image.onload = () => { images.set(url, image); paint(); resolve() }
    image.onerror = () => resolve()
    image.src = url
  })
  loading.set(url, job)
}

function renderPeople(): void {
  people.replaceChildren()
  if (!snapshot) return
  let shown = 0
  snapshot.members.slice(0, 50).forEach((member) => {
    const off = hidden.has(member.handle.toLowerCase())
    if (!off) shown += 1
    const inPicture = !off && shown <= style.count
    const item = el('li', off ? 'is-off' : inPicture ? undefined : 'is-out')
    item.append(el('span', 'xc-rank', inPicture ? String(shown) : ''))
    if (member.avatar) {
      const photo = el('img')
      photo.src = member.avatar
      photo.alt = ''
      photo.width = 40
      photo.height = 40
      photo.crossOrigin = 'anonymous'
      photo.referrerPolicy = 'no-referrer'
      item.append(photo)
    } else item.append(el('span', 'xc-initial', member.handle.slice(0, 1).toUpperCase()))
    const who = el('span', 'xc-who')
    const link = el('a', undefined, member.name)
    link.href = `https://x.com/${encodeURIComponent(member.handle)}`
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    const at = el('span', undefined, `@${member.handle}`)
    who.append(link, at)
    const why = el('span', 'xc-why')
    const counts = [member.replies && noun(member.replies, 'reply', 'replies'), member.mentions && noun(member.mentions, 'mention'), member.quotes && noun(member.quotes, 'quote'), member.reposts && noun(member.reposts, 'repost')].filter(Boolean).join(', ')
    const way = member.fromYou && member.fromThem ? 'Both ways' : member.fromYou ? `Only from @${snapshot!.owner.handle}` : `Only to @${snapshot!.owner.handle}`
    why.append(el('span', undefined, counts), el('span', undefined, way))
    const keep = el('label', 'xc-keep')
    const box = el('input')
    box.type = 'checkbox'
    box.checked = !off
    box.setAttribute('aria-label', `Show @${member.handle} in the circle`)
    box.addEventListener('change', () => {
      const key = member.handle.toLowerCase()
      const next = new Set(hidden)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      hidden = next
      renderPeople()
      paint()
    })
    keep.append(box)
    item.append(who, why, keep)
    people.append(item)
  })
}

function renderBasis(): void {
  if (!snapshot) return
  const count = Math.min(style.count, visibleMembers().length)
  const since = snapshot.oldest ? ` since ${new Date(snapshot.oldest * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''
  const seconds = ((performance.now() - startedAt) / 1000)
  basis.textContent = `${noun(count, 'person', 'people')} from ${noun(snapshot.postsRead, 'post')}${since}. ${snapshot.partial ? 'Still reading.' : `Finished in ${seconds.toFixed(1)}s.`}`
  if (!snapshot.partial && !snapshot.mentionsRead) basis.textContent += ' Posts by others could not be read, so mentions by others are missing: this circle comes from the account\'s own posts only.'
}

function showCircle(next: CircleSnapshot): void {
  snapshot = next
  title.textContent = `@${next.owner.handle}'s circle`
  result.hidden = false
  result.dataset.state = next.partial ? 'partial' : 'done'
  for (const person of [next.owner, ...next.members]) ensureImage(person.avatar)
  renderBasis()
  renderPeople()
  paint()
  if (!next.partial) {
    window.clearInterval(clockTimer)
    status.replaceChildren()
    form.classList.remove('is-working')
    go.hidden = false
    document.querySelector<HTMLButtonElement>('#xc-stop')!.hidden = true
  }
}

function renderStatus(phase: 'posts' | 'people', posts: number, mentions: number): void {
  const current = phase === 'people' ? 1 : 0
  const progress = phase === 'people' ? 0.9 : Math.min(0.86, 0.08 + 0.62 * Math.min(1, posts / 450) + 0.16 * Math.min(1, mentions / 150))
  const percent = Math.round(progress * 100)
  const root = el('div', 'scan')
  root.setAttribute('role', 'status')
  const head = el('div', 'scan-head')
  head.append(el('span', 'scan-spin'))
  const copy = el('div')
  copy.append(el('p', 'scan-title', `Reading @${cleanHandle(input.value) ?? input.value}'s posts`))
  const sub = el('p', 'scan-sub')
  sub.append('The circle draws as posts arrive. ', el('span', 'scan-clock', clock()))
  copy.append(sub)
  head.append(copy)
  const bar = el('div', 'scan-bar')
  bar.setAttribute('role', 'progressbar')
  bar.setAttribute('aria-valuemin', '0')
  bar.setAttribute('aria-valuemax', '100')
  bar.setAttribute('aria-valuenow', String(percent))
  const fill = el('span')
  fill.style.width = `${percent}%`
  bar.append(fill)
  const list = el('ol', 'scan-steps')
  STEPS.forEach((step, index) => {
    const state = index < current ? 'done' : index === current ? 'now' : 'next'
    const item = el('li', `is-${state}`)
    item.append(el('span', 'scan-dot'))
    const label = el('span')
    label.append(step.label)
    if (state === 'now') {
      const detail = el('em')
      detail.dataset.livePosts = String(posts)
      detail.dataset.liveMentions = String(mentions)
      detail.textContent = ` ${noun(posts, 'post')}, ${noun(mentions, 'reply', 'replies')} and mentions`
      label.append(detail)
    }
    item.append(label)
    list.append(item)
  })
  root.append(head, bar, list)
  status.replaceChildren(root)
}

function clock(): string {
  const seconds = Math.floor((performance.now() - startedAt) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

async function readStream(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.ok || !response.body) {
    const problem = await response.json().catch(() => null) as { code?: string } | null
    throw new Error(problem?.code ?? 'unavailable')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const consume = (line: string) => {
    if (!line.startsWith('data:')) return
    const event = JSON.parse(line.slice(5).trim()) as { type: string; code?: string; phase?: 'posts' | 'people'; posts?: number; mentions?: number } & Partial<CircleSnapshot>
    if (event.type === 'progress') renderStatus(event.phase ?? 'posts', event.posts ?? 0, event.mentions ?? 0)
    if (event.type === 'circle') showCircle(event as CircleSnapshot)
    if (event.type === 'done' && event.snapshot) showCircle({ ...(event.snapshot as CircleSnapshot), partial: false })
    if (event.type === 'error') throw new Error(event.code ?? 'unavailable')
  }
  while (!signal.aborted) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      consume(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }
  consume(buffer.trim())
}

async function run(raw: string): Promise<void> {
  const handle = cleanHandle(raw)
  if (!handle) {
    error.hidden = false
    error.textContent = ERRORS.bad_handle!
    return
  }
  abort?.abort()
  abort = new AbortController()
  const signal = abort.signal
  startedAt = performance.now()
  window.clearInterval(clockTimer)
  clockTimer = window.setInterval(() => {
    const node = document.querySelector('.scan-clock')
    if (node) node.textContent = clock()
  }, 1000)
  snapshot = null
  hidden = new Set()
  error.hidden = true
  result.hidden = true
  result.dataset.state = ''
  form.classList.add('is-working')
  go.hidden = true
  document.querySelector<HTMLButtonElement>('#xc-stop')!.hidden = false
  renderStatus('posts', 0, 0)
  const fresh = new URLSearchParams(location.search).get('fresh') === '1'
  try {
    const response = await fetch(`/api/circle?handle=${encodeURIComponent(handle)}${fresh ? '&fresh=1' : ''}`, { signal, headers: { Accept: 'text/event-stream' } })
    await readStream(response, signal)
    if (!signal.aborted && result.dataset.state !== 'done') {
      window.clearInterval(clockTimer)
      error.hidden = false
      error.textContent = ERRORS.unavailable!
      form.classList.remove('is-working')
      status.replaceChildren()
      go.hidden = false
      document.querySelector<HTMLButtonElement>('#xc-stop')!.hidden = true
    }
  } catch (caught) {
    if (signal.aborted) {
      window.clearInterval(clockTimer)
      form.classList.remove('is-working')
      status.replaceChildren()
      go.hidden = false
      document.querySelector<HTMLButtonElement>('#xc-stop')!.hidden = true
      return
    }
    window.clearInterval(clockTimer)
    const code = caught instanceof Error ? caught.message : 'unavailable'
    error.hidden = false
    error.textContent = ERRORS[code] ?? ERRORS.unavailable!
    form.classList.remove('is-working')
    status.replaceChildren()
    go.hidden = false
    document.querySelector<HTMLButtonElement>('#xc-stop')!.hidden = true
  }
}

function bindStyle(): void {
  const paintPresets = () => {
    swatches.replaceChildren()
    for (const preset of PRESETS) {
      const on = style.background === preset.background && style.color1 === preset.color1 && (preset.background === 'solid' || style.color2 === preset.color2)
      const button = el('button', `xc-swatch${on ? ' is-on' : ''}`)
      button.type = 'button'
      button.setAttribute('aria-pressed', String(on))
      const chip = el('span')
      chip.style.background = preset.background === 'gradient' ? `linear-gradient(135deg, ${preset.color1}, ${preset.color2})` : preset.color1
      button.append(chip, document.createTextNode(preset.name))
      button.addEventListener('click', () => {
        style = { ...style, background: preset.background, color1: preset.color1, color2: preset.color2 }
        paintPresets()
        paint()
      })
      swatches.append(button)
    }
  }
  paintPresets()
  document.querySelectorAll<HTMLButtonElement>('[data-fill]').forEach((button) => {
    button.addEventListener('click', () => {
      style = { ...style, background: button.dataset.fill === 'solid' ? 'solid' : 'gradient' }
      document.querySelectorAll<HTMLButtonElement>('[data-fill]').forEach((peer) => peer.setAttribute('aria-pressed', String(peer === button)))
      paint()
    })
  })
  const color1 = document.querySelector<HTMLInputElement>('#xc-color1')!
  const color2 = document.querySelector<HTMLInputElement>('#xc-color2')!
  color1.addEventListener('input', () => { style = { ...style, color1: color1.value }; paint() })
  color2.addEventListener('input', () => { style = { ...style, color2: color2.value }; paint() })
  const count = document.querySelector<HTMLInputElement>('#xc-count')!
  const scale = document.querySelector<HTMLInputElement>('#xc-scale')!
  const countOut = document.querySelector<HTMLOutputElement>('#xc-count-out')!
  const scaleOut = document.querySelector<HTMLOutputElement>('#xc-scale-out')!
  count.addEventListener('input', () => {
    style = { ...style, count: Number(count.value) }
    countOut.textContent = String(Math.min(style.count, visibleMembers().length))
    renderPeople()
    paint()
  })
  scale.addEventListener('input', () => {
    style = { ...style, nodeScale: Number(scale.value) / 100 }
    scaleOut.textContent = `${scale.value}%`
    paint()
  })
  document.querySelectorAll<HTMLInputElement>('[data-flag]').forEach((box) => {
    box.addEventListener('change', () => {
      const flag = box.dataset.flag as 'names' | 'ranks' | 'rings'
      style = { ...style, [flag]: box.checked }
      paint()
    })
  })
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  if (!form.classList.contains('is-working')) void run(input.value)
})
document.querySelector<HTMLButtonElement>('#xc-stop')!.addEventListener('click', () => abort?.abort())
download.addEventListener('click', async () => {
  const blob = await toPngBlob(canvas)
  if (!blob || !snapshot) return
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `x-circle-${snapshot.owner.handle}.png`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
})
bindStyle()

const presetHandle = new URLSearchParams(location.search).get('u')
if (presetHandle) {
  input.value = presetHandle.replace(/^@/, '')
  if (new URLSearchParams(location.search).get('autostart') === '1') void run(input.value)
}
