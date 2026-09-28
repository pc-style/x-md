import { cleanHandle, rank, type Interaction, type Member, type Person } from './core.ts'
import { DEFAULT_STYLE, draw, loadImage, SIZE, toPngBlob, type Circle, type Style } from './draw.ts'
import type { CircleEvent } from './harvest.ts'

const FOOTER = 'x-circle · fast demo'
const TOP = 50
const ERRORS: Record<string, string> = {
  bad_handle: 'That is not an X username. It is 1 to 15 letters, numbers or underscores, like @cutnoodle.',
  not_found: 'There is no X account with that username. Check the spelling and try again.',
  private: 'This account is private, so its posts cannot be read. X Circle works on public accounts only.',
  empty: 'This account has no recent public posts to read, so there is no one to put in the circle yet.',
  no_one: 'The recent posts of this account do not reply to, quote, repost or mention anyone, so the circle would be empty.',
  unavailable: 'X posts could not be read right now. Wait a minute and try again.',
  rate_limited: 'Too many circles from this address. Wait a few minutes and try again.',
}
const SWATCHES = [
  { name: 'Navy', bg: 'gradient', c1: '#00123B', c2: '#26286B' },
  { name: 'Purple', bg: 'gradient', c1: '#996CFC', c2: '#5946AB' },
  { name: 'Gold', bg: 'gradient', c1: '#FEDE95', c2: '#FEF9F4' },
  { name: 'Cream', bg: 'solid', c1: '#FEF9F4', c2: '#F3EDFF' },
  { name: 'Grey', bg: 'solid', c1: '#B2B4BC', c2: '#DBD8DA' },
  { name: 'Night', bg: 'solid', c1: '#00123B', c2: '#26286B' },
] as const

/** Timing marks, in ms since the button was pressed; the benchmark harness reads them. */
interface Marks { start: number; firstProgress?: number; firstCircle?: number; harvestDone?: number; complete?: number }
declare global { interface Window { __xc?: { handle: string; marks: Marks; postsRead: number; posts: number; mentions: number; state: string } } }

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T
const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const form = $<HTMLFormElement>('#xc-form')
const input = $<HTMLInputElement>('#xc-handle')
const go = $<HTMLButtonElement>('#xc-go')
const scan = $<HTMLDivElement>('#xc-scan')
const errorBox = $<HTMLParagraphElement>('#xc-error')
const result = $<HTMLElement>('#xc-result')
const canvas = $<HTMLCanvasElement>('#xc-canvas')
const basis = $<HTMLParagraphElement>('#xc-basis')
const list = $<HTMLOListElement>('#xc-list')
const live = $<HTMLSpanElement>('#xc-live')
const examples = $<HTMLElement>('#xc-examples')

let style: Style = { ...DEFAULT_STYLE }
let run: {
  handle: string
  owner: Person
  interactions: Interaction[]
  posts: number
  mentions: number
  oldest: number | null
  mentionsSource: 'search' | 'replies' | null | undefined
  done: boolean
  marks: Marks
  controller: AbortController
  profiles: Map<string, Person>
  requested: Set<string>
  inflight: number
  createdAt: number
  job: string | null
} | null = null
const removed = new Set<string>()
const images = new Map<string, HTMLImageElement>()
let ranked: Member[] = []

const since = (marks: Marks) => Math.round(performance.now() - marks.start)
function publish(state: string) {
  if (!run) return
  window.__xc = { handle: run.handle, marks: run.marks, postsRead: run.posts + run.mentions, posts: run.posts, mentions: run.mentions, state }
  document.documentElement.dataset.xcState = state
}

function setWorking(on: boolean) {
  input.disabled = on
  go.textContent = on ? 'Stop' : 'Make my circle'
  go.className = on ? 'xc-go xc-go--stop' : 'xc-go'
  go.type = on ? 'button' : 'submit'
  go.disabled = !on && !input.value.trim()
  form.classList.toggle('is-working', on)
  scan.hidden = !on
}

function showError(code: string | null) {
  errorBox.hidden = !code
  errorBox.textContent = code ? ERRORS[code] ?? ERRORS.unavailable : ''
}

// ---- progress widget -------------------------------------------------------

let clock = 0
function renderScan() {
  if (!run) return
  const step = !run.owner.avatar && !run.posts ? 'profile' : run.done ? 'people' : 'posts'
  const progress = step === 'profile' ? 0.04 : step === 'people' ? 0.9 : 0.06 + 0.62 * Math.min(1, run.posts / 900) + 0.2 * Math.min(1, run.mentions / 150)
  const bar = scan.querySelector<HTMLSpanElement>('.scan-bar span')!
  bar.style.width = `${Math.round(100 * Math.min(0.97, progress))}%`
  const steps = [
    ['profile', 'Finding the account', ''],
    ['posts', 'Reading recent posts and mentions', `${plural(run.posts, 'post')}, ${plural(run.mentions, 'reply', 'replies')} and mentions`],
    ['people', 'Scoring people and fetching their photos', ''],
  ]
  const at = steps.findIndex(([id]) => id === step)
  scan.querySelector('.scan-steps')!.innerHTML = steps.map(([, label, detail], i) => {
    const state = i < at ? 'done' : i === at ? 'now' : 'next'
    return `<li class="is-${state}"><span class="scan-dot" aria-hidden="true"></span><span>${label}${state === 'now' && detail ? ` <em>${detail}</em>` : ''}</span></li>`
  }).join('')
  const s = Math.floor(since(run.marks) / 1000)
  scan.querySelector('.scan-clock')!.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ---- ranking and drawing ---------------------------------------------------

function members(): Member[] {
  if (!run) return []
  const profiles = run.profiles
  return ranked
    .filter((m) => !removed.has(m.handle.toLowerCase()))
    .map((m) => {
      const known = profiles.get(m.handle.toLowerCase())
      return known ? { ...m, name: known.name, avatar: m.avatar ?? known.avatar } : m
    })
}

function circle(): Circle | null {
  if (!run) return null
  return { owner: run.owner, createdAt: run.createdAt, members: members() }
}

let frame = 0
let listDue = 0
function schedule() {
  if (!frame) frame = requestAnimationFrame(render)
}

function render() {
  frame = 0
  if (!run) return
  renderScan()
  const c = circle()
  if (!c || !c.members.length) return
  if (result.hidden) {
    result.hidden = false
    examples.hidden = true
  }
  const shown = Math.min(style.count, c.members.length)
  const urls = [c.owner.avatar, ...c.members.slice(0, style.count).map((m) => m.avatar)].filter((u): u is string => Boolean(u))
  for (const url of urls) {
    if (images.has(url)) continue
    void loadImage(url).then((img) => { if (img && !images.has(url)) { images.set(url, img); schedule() } })
  }
  draw(canvas, c, style, images, FOOTER)
  canvas.setAttribute('aria-label', `Interaction circle of @${c.owner.handle}: ${c.members.slice(0, Math.min(10, style.count)).map((m) => '@' + m.handle).join(', ')}${shown > 10 ? ' and others' : ''}.`)
  if (run.marks.firstCircle === undefined) run.marks.firstCircle = since(run.marks)

  const date = run.oldest ? ` since ${new Date(run.oldest * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''
  const missing = run.done && !run.mentionsSource ? ' Posts by others could not be read, so mentions by others are missing: this circle comes from the account\'s own posts only.' : ''
  const fromReplies = run.done && run.mentionsSource === 'replies' ? ' Search was unavailable, so incoming interactions come from the replies under the account\'s own posts.' : ''
  basis.textContent = `${plural(shown, 'person', 'people')} from ${plural(run.posts + run.mentions, 'post')}${date}.${missing}${fromReplies}`
  const people = $<HTMLOutputElement>('#xc-count')
  const slider = $<HTMLInputElement>('#xc-count-range')
  const max = Math.max(10, Math.min(TOP, c.members.length))
  slider.min = String(Math.min(10, max))
  slider.max = String(max)
  slider.value = String(Math.min(style.count, max))
  people.textContent = String(shown)

  const now = performance.now()
  if (run.done || now >= listDue) {
    listDue = now + 300
    renderList()
  }
  requestAvatars(c.members)
  checkComplete(c)
}

function renderList() {
  if (!run) return
  const owner = run.owner.handle
  let n = 0
  const profiles = run.profiles
  list.innerHTML = ranked.slice(0, TOP).map((raw) => {
    const known = profiles.get(raw.handle.toLowerCase())
    const m = known ? { ...raw, name: known.name, avatar: raw.avatar ?? known.avatar } : raw
    const off = removed.has(m.handle.toLowerCase())
    if (!off) n++
    const inside = !off && n <= style.count
    const why = [m.replies && plural(m.replies, 'reply', 'replies'), m.mentions && plural(m.mentions, 'mention'), m.quotes && plural(m.quotes, 'quote'), m.reposts && plural(m.reposts, 'repost')].filter(Boolean).join(', ')
    const way = m.fromYou && m.fromThem ? 'Both ways' : m.fromYou ? `Only from @${esc(owner)}` : `Only to @${esc(owner)}`
    const photo = m.avatar ? `<img src="${esc(m.avatar)}" alt="" width="40" height="40" crossorigin="anonymous" loading="lazy">` : `<span class="xc-initial" aria-hidden="true">${esc(m.handle.slice(0, 1).toUpperCase())}</span>`
    return `<li class="${off ? 'is-off' : inside ? '' : 'is-out'}"><span class="xc-rank">${inside ? n : ''}</span>${photo}<span class="xc-who"><a href="https://x.com/${esc(m.handle)}" target="_blank" rel="noopener noreferrer">${esc(m.name)}</a><span>@${esc(m.handle)}</span></span><span class="xc-why"><span>${why}</span><span>${way}</span></span><label class="xc-keep"><input type="checkbox" data-handle="${esc(m.handle.toLowerCase())}" ${off ? '' : 'checked'} aria-label="Show @${esc(m.handle)} in the circle"></label></li>`
  }).join('')
}

/** Anyone in the top 50 who arrived as a bare handle gets their name and photo fetched right away, in one batch. */
let avatarTimer = 0
/** While posts still stream the top 50 shifts, so photos are fetched a little past it. */
const unresolved = (r: NonNullable<typeof run>, current: Member[]) =>
  current.slice(0, r.done ? TOP : TOP + 20).filter((m) => !m.avatar && !r.profiles.has(m.handle.toLowerCase()) && !r.requested.has(m.handle.toLowerCase())).map((m) => m.handle)
function requestAvatars(current: Member[]) {
  if (!run || avatarTimer || !unresolved(run, current).length) return
  const r = run
  avatarTimer = window.setTimeout(() => {
    avatarTimer = 0
    const wanted = unresolved(r, members())
    if (!wanted.length) { schedule(); return }
    for (const h of wanted) r.requested.add(h.toLowerCase())
    if (!r.job) return
    r.inflight += 1
    void fetch(`/api/circle/${r.job}/profiles?handles=${encodeURIComponent(wanted.join(','))}`, { method: 'POST', signal: r.controller.signal })
      .then((response) => { if (!response.ok) settleProfiles(r, wanted) })
      .catch(() => settleProfiles(r, wanted))
  }, r.done ? 0 : 250)
}

/** A photo request has finished: anyone it did not resolve keeps their initial. */
function settleProfiles(r: NonNullable<typeof run>, handles: string[]) {
  r.inflight -= 1
  for (const h of handles) if (!r.profiles.has(h.toLowerCase())) r.profiles.set(h.toLowerCase(), { handle: h, name: h, avatar: null })
  schedule()
}

function checkComplete(c: Circle) {
  if (!run || !run.done || run.marks.complete !== undefined || run.inflight > 0 || avatarTimer) return
  const top = c.members.slice(0, style.count)
  if (top.some((m) => !m.avatar && !run!.profiles.has(m.handle.toLowerCase()))) return
  const urls = [c.owner.avatar, ...top.map((m) => m.avatar)].filter((u): u is string => Boolean(u))
  const r = run
  void Promise.all(urls.map(async (url) => { const img = await loadImage(url); if (img) images.set(url, img) })).then(() => {
    if (run !== r || r.marks.complete !== undefined) return
    requestAnimationFrame(() => {
      if (!run) return
      render()
      run.marks.complete = since(run.marks)
      const seconds = run.marks.complete / 1000
      const read = run.posts + run.mentions
      live.textContent = `Complete in ${seconds.toFixed(1)} s · ${plural(read, 'post')} · ${Math.round(read / seconds)} posts/s`
      live.classList.add('is-done')
      publish('complete')
      setWorking(false)
    })
  })
}

// ---- the run ---------------------------------------------------------------

function stop() {
  if (!run) return
  run.controller.abort()
  if (run.job) void fetch(`/api/circle/${run.job}`, { method: 'DELETE', keepalive: true }).catch(() => {})
}

async function start(raw: string) {
  const handle = cleanHandle(raw)
  if (!handle) { showError('bad_handle'); return }
  stop()
  showError(null)
  removed.clear()
  ranked = []
  result.hidden = true
  live.textContent = 'Live · updating as posts arrive'
  live.classList.remove('is-done')
  const marks: Marks = { start: performance.now() }
  run = {
    handle, owner: { handle, name: handle, avatar: null }, interactions: [], posts: 0, mentions: 0, oldest: null, mentionsSource: undefined,
    done: false, marks, controller: new AbortController(), profiles: new Map(), requested: new Set(), inflight: 0, createdAt: Date.now(), job: null,
  }
  const r = run
  $('.scan-title').textContent = `Reading @${handle}'s posts`
  setWorking(true)
  publish('working')
  clearInterval(clock)
  clock = window.setInterval(() => { if (run === r && !r.done) renderScan() }, 1000)
  renderScan()
  const fail = (code: string) => {
    if (run !== r) return
    clearInterval(clock)
    setWorking(false)
    showError(code)
    publish('error')
  }
  try {
    const created = await fetch(`/api/circle?handle=${encodeURIComponent(handle)}`, { method: 'POST', signal: r.controller.signal })
    if (!created.ok) { fail(created.status === 429 ? 'rate_limited' : created.status === 400 ? 'bad_handle' : 'unavailable'); return }
    r.job = ((await created.json()) as { id: string }).id
    let cursor = 0
    // Long polling: each request returns as soon as anything new is logged. It keeps
    // going after the circle is complete so photos asked for later still arrive.
    while (run === r) {
      const response = await fetch(`/api/circle/${r.job}?after=${cursor}`, { signal: r.controller.signal })
      if (!response.ok) { fail('unavailable'); return }
      const page = (await response.json()) as { events: CircleEvent[]; next: number; closed: boolean }
      cursor = page.next
      for (const event of page.events) if (!apply(r, event, fail)) return
      if (page.events.length) { publish(r.marks.complete !== undefined ? 'complete' : r.done ? 'harvested' : 'working'); schedule() }
      if (page.closed) { if (!r.done) fail('unavailable'); return }
    }
  } catch {
    if (r.controller.signal.aborted) {
      if (run === r && r.marks.complete === undefined) { setWorking(false); publish('stopped') }
      return
    }
    fail('unavailable')
  }
}

/** Folds one logged event into the run; false means the run has ended in an error. */
function apply(r: NonNullable<typeof run>, event: CircleEvent, fail: (code: string) => void): boolean {
  switch (event.type) {
    case 'profile':
      r.owner = { handle: event.profile.handle, name: event.profile.name, avatar: event.profile.avatar }
      r.handle = event.profile.handle
      input.value = event.profile.handle
      return true
    case 'batch':
      r.interactions.push(...event.interactions)
      r.posts = event.posts
      r.mentions = event.mentions
      if (event.oldest && (r.oldest === null || event.oldest < r.oldest)) r.oldest = event.oldest
      if (r.marks.firstProgress === undefined && (r.posts > 0 || r.mentions > 0)) r.marks.firstProgress = since(r.marks)
      ranked = rank(r.interactions)
      return true
    case 'mentions-source':
      r.mentionsSource = event.source
      return true
    case 'done':
      r.posts = event.posts
      r.mentions = event.mentions
      r.oldest = event.oldest
      r.mentionsSource = event.mentionsSource
      r.done = true
      r.marks.harvestDone = since(r.marks)
      ranked = rank(r.interactions)
      if (!ranked.length) { fail('no_one'); return false }
      style = { ...style, count: Math.min(Math.max(10, style.count), TOP) }
      return true
    case 'person':
      r.profiles.set(event.person.handle.toLowerCase(), event.person)
      return true
    case 'profiles-done':
      settleProfiles(r, event.handles)
      return true
    case 'error':
      fail(event.code)
      return false
    default: {
      const never: never = event
      throw new Error(`unexpected event ${JSON.stringify(never)}`)
    }
  }
}

// ---- controls --------------------------------------------------------------

function renderPanel() {
  $('#xc-swatches').innerHTML = SWATCHES.map((s) => {
    const on = style.background === s.bg && style.color1 === s.c1 && (s.bg === 'solid' || style.color2 === s.c2)
    const fill = s.bg === 'gradient' ? `linear-gradient(135deg, ${s.c1}, ${s.c2})` : s.c1
    return `<button type="button" class="xc-swatch${on ? ' is-on' : ''}" aria-pressed="${on}" data-swatch="${s.name}"><span aria-hidden="true" style="background:${fill}"></span>${s.name}</button>`
  }).join('')
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fill]')) button.setAttribute('aria-pressed', String(style.background === button.dataset.fill))
  $<HTMLInputElement>('#xc-color1').value = style.color1
  $<HTMLInputElement>('#xc-color2').value = style.color2
  $('#xc-color1-label').lastChild!.textContent = style.background === 'gradient' ? 'From' : 'Colour'
  $('#xc-color2-wrap').hidden = style.background !== 'gradient'
  $('#xc-scale').textContent = `${Math.round(style.nodeScale * 100)}%`
  for (const key of ['names', 'ranks', 'rings'] as const) $<HTMLInputElement>(`#xc-${key}`).checked = style[key]
}

function update(patch: Partial<Style>) {
  style = { ...style, ...patch }
  renderPanel()
  listDue = 0
  schedule()
}

form.addEventListener('submit', (e) => { e.preventDefault(); if (!form.classList.contains('is-working')) void start(input.value) })
go.addEventListener('click', (e) => { if (go.type === 'button') { e.preventDefault(); stop() } })
input.addEventListener('input', () => { go.disabled = !input.value.trim() && go.type === 'submit' })
$('#xc-swatches').addEventListener('click', (e) => {
  const name = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-swatch]')?.dataset.swatch
  const s = SWATCHES.find((x) => x.name === name)
  if (s) update({ background: s.bg, color1: s.c1, color2: s.c2 })
})
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-fill]')) button.addEventListener('click', () => update({ background: button.dataset.fill as Style['background'] }))
$<HTMLInputElement>('#xc-color1').addEventListener('input', (e) => update({ color1: (e.target as HTMLInputElement).value }))
$<HTMLInputElement>('#xc-color2').addEventListener('input', (e) => update({ color2: (e.target as HTMLInputElement).value }))
$<HTMLInputElement>('#xc-count-range').addEventListener('input', (e) => update({ count: Number((e.target as HTMLInputElement).value) }))
$<HTMLInputElement>('#xc-scale-range').addEventListener('input', (e) => update({ nodeScale: Number((e.target as HTMLInputElement).value) / 100 }))
for (const key of ['names', 'ranks', 'rings'] as const) $<HTMLInputElement>(`#xc-${key}`).addEventListener('change', (e) => update({ [key]: (e.target as HTMLInputElement).checked }))
list.addEventListener('change', (e) => {
  const handle = (e.target as HTMLInputElement).dataset.handle
  if (!handle) return
  if (removed.has(handle)) removed.delete(handle); else removed.add(handle)
  listDue = 0
  schedule()
})

$('#xc-download').addEventListener('click', async () => {
  if (!run) return
  const blob = await toPngBlob(canvas)
  if (!blob) return
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `x-circle-${run.owner.handle}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
})
$('#xc-copy').addEventListener('click', async () => {
  const note = $('#xc-share-note')
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPngBlob(canvas).then((b) => { if (!b) throw new Error('no png'); return b }) })])
    note.textContent = 'The picture is copied. Paste it into your post.'
  } catch {
    note.textContent = 'Copying is not available here. Download the PNG instead.'
  }
})
$('#xc-post').addEventListener('click', () => {
  if (!run) return
  const text = `My X circle: the people @${run.owner.handle} talks with most`
  window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
})

canvas.width = SIZE
canvas.height = SIZE
renderPanel()
const preset = new URLSearchParams(location.search).get('u')
if (preset) {
  input.value = preset
  history.replaceState(null, '', location.pathname)
  void start(preset)
}
