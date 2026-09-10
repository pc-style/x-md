import './admin.css'
import type { ApiKeyView } from '../lib/apikeys'
import type { PoolSnapshot } from '../lib/pool'
import type { searchRateModel } from '../lib/xsearch'

interface UpstreamView {
  base: string
  kind: 'self-hosted' | 'external'
  total?: number
  ready?: number
  resting?: number
  retired?: number
  unknown?: number
  remainingKnown?: number
  error?: string
}

type PoolView = ReturnType<typeof searchRateModel> & {
  durableStore: boolean
  keyCount: number
  activeKeyCount: number
  allocatedToKeysPer15m: number
  share: PoolSnapshot
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const input = (id: string) => $<HTMLInputElement>(id)
const text = (id: string, value: string | number) => { $(id).textContent = typeof value === 'number' ? value.toLocaleString() : value }
const TOKEN_KEY = 'xmd_admin_token'
let token = sessionStorage.getItem(TOKEN_KEY) || ''
let session = new AbortController()
let refreshing: Promise<boolean> | undefined
let mutating = false
let snapshot: PoolView | undefined
let receivedAt = 0
let refreshFailed = false
let keyRecords = new Map<string, ApiKeyView>()

function message(id: string, value = '', error = false) {
  text(id, value)
  $(id).hidden = !value
  $(id).classList.toggle('error', error)
}

function setBusy(busy: boolean) {
  $('refresh').setAttribute('aria-busy', String(busy))
  document.querySelectorAll<HTMLButtonElement>('#app button, #createDialog button:not(#copySecret), #refresh').forEach((button) => { button.disabled = busy })
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const signal = session.signal
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  })
  const data = await response.json().catch(() => ({}))
  signal.throwIfAborted()
  if (response.status === 401) {
    lock('Token rejected or expired. Enter your admin token to try again.')
    throw new DOMException('Session ended', 'AbortError')
  }
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status}).`)
  return data as T
}

const percent = (value: number, total: number) => total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0

function meter(element: HTMLElement, value: number, total: number, description: string, warn = false) {
  const ratio = percent(value, total)
  element.setAttribute('aria-valuenow', String(Math.round(ratio)))
  element.setAttribute('aria-valuetext', description)
  element.classList.toggle('low', warn)
  element.querySelector<HTMLElement>('.meter-fill')!.style.transform = `scaleX(${ratio / 100})`
}

function renderPool(p: PoolView) {
  const s = p.share
  const used = s.publicUsed + s.keysUsed
  const remaining = Math.max(0, s.capacity - used)
  const left = percent(remaining, s.capacity)
  text('remaining', remaining)
  text('capacity', s.capacity)
  text('used', used)
  text('reserved', s.keysReserved)
  meter($('capacityMeter'), remaining, s.capacity, `${remaining} of ${s.capacity} searches remaining`, left <= 20)

  const cooling = Math.max(0, p.activeAccounts - p.healthyAccounts)
  text('healthy', p.healthyAccounts)
  text('accounts', p.activeAccounts)
  text('cooldownNote', !p.activeAccounts ? 'None configured' : cooling ? `${cooling} cooling down` : '')
  text('accountBudget', `${p.perAccountBudget} / 15m`)
  text('headroom', `${Math.round(p.headroom * 100)}%`)
  text('storage', p.durableStore ? 'Durable KV' : 'In-memory')
  text('publicRemaining', s.publicRemaining)
  text('publicCap', s.publicCap)
  text('ipBudget', p.publicIpBudget)
  meter($('publicMeter'), s.publicRemaining, s.publicCap, `${s.publicRemaining} of ${s.publicCap} public searches remaining`, percent(s.publicRemaining, s.publicCap) <= 20)
  text('keysUsed', s.keysUsed)
  text('activeKeys', p.activeKeyCount)
  text('idleKeys', s.keys.filter((key) => key.idle && !key.disabled).length)
  text('keyCount', p.keyCount)
  text('assigned', p.allocatedToKeysPer15m)
  text('defaultLimit', p.defaultKeyLimit)
  input('newLimit').placeholder = String(p.defaultKeyLimit)
  if (!input('idleMinutes').dataset.dirty) input('idleMinutes').value = String(s.idleReleaseMinutes)

  const warnings: string[] = []
  if (!remaining && s.capacity) warnings.push('Search pool exhausted. Key search allowances still depend on the pool.')
  // Without search sessions the pool is simply absent; allowances are then meaningless, not overallocated.
  if (s.capacity && p.allocatedToKeysPer15m > s.capacity) warnings.push(`Overallocated: ${p.allocatedToKeysPer15m.toLocaleString()} assigned / ${s.capacity.toLocaleString()} search capacity.`)
  if (!s.capacity) warnings.push('No search sessions on this deployment: search falls through to public providers. Imports use the import upstream.')
  if (!p.durableStore) warnings.push('In-memory store. Set KV_REST_API_URL and KV_REST_API_TOKEN to persist keys.')
  message('poolWarning', warnings.join(' '))
}

function renderUpstream(upstreams: UpstreamView[]) {
  const own = upstreams.filter((u) => u.kind === 'self-hosted')
  const total = own.reduce((a, u) => a + (u.total ?? 0), 0)
  const ready = own.reduce((a, u) => a + (u.ready ?? 0), 0)
  const resting = own.reduce((a, u) => a + (u.resting ?? 0), 0)
  const retired = own.reduce((a, u) => a + (u.retired ?? 0), 0)
  const remaining = own.reduce((a, u) => a + (u.remainingKnown ?? 0), 0)
  const failed = own.filter((u) => u.error)
  text('importReady', own.length ? ready : '—')
  text('importTotal', own.length ? total : '—')
  const notes: string[] = []
  if (!own.length) notes.push(upstreams.length ? 'Public upstream only' : 'No upstream configured')
  if (resting) notes.push(`${resting} resting`)
  if (retired) notes.push(`${retired} retired`)
  if (remaining) notes.push(`${remaining.toLocaleString()} requests left this window (seen)`)
  if (failed.length) notes.push(`${failed.length} upstream${failed.length > 1 ? 's' : ''} unreachable`)
  text('importNote', notes.join(' · '))
  $('importNote').title = upstreams.map((u) => `${u.base}: ${u.kind}${u.error ? ` (${u.error})` : ''}`).join('\n')
}

function renderKeys(keys: ApiKeyView[], shares: PoolSnapshot['keys']) {
  const tbody = $('keys')
  keyRecords = new Map(keys.map((key) => [key.id, key]))
  const byId = new Map(shares.map((share) => [share.id, share]))
  for (const row of tbody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')) {
    if (!keyRecords.has(row.dataset.id!)) row.remove()
  }
  tbody.querySelector('.empty-row')?.remove()
  if (!keys.length) {
    tbody.innerHTML = '<tr class="empty-row"><td class="empty" colspan="8">No keys yet.</td></tr>'
    return
  }
  for (const key of keys) {
    // Keep rows and edited inputs in place during refreshes; only update their data.
    let row = Array.from(tbody.querySelectorAll<HTMLTableRowElement>('tr[data-id]')).find((row) => row.dataset.id === key.id)
    if (!row) {
      row = document.createElement('tr')
      row.dataset.id = key.id
      row.innerHTML = `<td><span class="key-label"></span><code class="key-id"></code></td>
        <td><input class="key-limit" type="number" min="1" step="1" required /></td>
        <td class="key-remaining"><span class="key-left"></span><div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100"><div class="meter-fill"></div></div></td>
        <td><input class="key-import-limit" type="number" min="1" step="1" required /></td>
        <td class="key-import-remaining"><span class="key-import-left"></span><div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100"><div class="meter-fill"></div></div></td>
        <td><span class="key-status"></span></td><td class="key-last muted"></td>
        <td><div class="row-actions"><button class="ghost" data-action="save">Save</button><button class="ghost" data-action="toggle"></button><button class="ghost danger" data-action="delete">Delete</button></div></td>`
      row.querySelectorAll('input').forEach((field) => field.addEventListener('input', (event) => { (event.target as HTMLInputElement).dataset.dirty = 'true' }))
      tbody.appendChild(row)
    }
    const set = (selector: string, value: string) => { row!.querySelector(selector)!.textContent = value }
    const share = byId.get(key.id)
    const remaining = share ? Math.max(0, key.limitPer15m - share.used) : 0
    set('.key-label', key.label)
    row.querySelector<HTMLElement>('.key-label')!.title = key.label
    set('.key-id', key.id)
    const limit = row.querySelector<HTMLInputElement>('.key-limit')!
    limit.setAttribute('aria-label', `Allowance for ${key.label}`)
    if (!limit.dataset.dirty) limit.value = String(key.limitPer15m)
    set('.key-left', key.disabled ? '—' : share ? `${remaining.toLocaleString()} / ${key.limitPer15m.toLocaleString()}` : 'Unavailable')
    row.querySelector<HTMLElement>('.key-remaining')!.title = share ? `${share.used} used, ${share.reserved} reserved. Shared pool availability applies.` : 'Refresh to load usage'
    const bar = row.querySelector<HTMLElement>('.meter')!
    bar.setAttribute('aria-label', `Remaining allowance for ${key.label}`)
    meter(bar, key.disabled ? 0 : remaining, key.limitPer15m, key.disabled ? 'Key disabled; no available allowance' : share ? `${remaining} of ${key.limitPer15m} remaining; shared pool availability applies` : 'Usage unavailable', !remaining && !key.disabled)
    const importLimitField = row.querySelector<HTMLInputElement>('.key-import-limit')!
    const importLimit = share?.importLimit ?? key.importPer15m ?? 0
    importLimitField.setAttribute('aria-label', `Bulk import allowance for ${key.label}`)
    if (!importLimitField.dataset.dirty) importLimitField.value = String(importLimit)
    const importLeft = share ? Math.max(0, importLimit - share.importUsed) : 0
    set('.key-import-left', key.disabled ? '—' : share ? `${importLeft.toLocaleString()} / ${importLimit.toLocaleString()}` : 'Unavailable')
    const importBar = row.querySelector<HTMLElement>('.key-import-remaining .meter')!
    importBar.setAttribute('aria-label', `Remaining bulk imports for ${key.label}`)
    meter(importBar, key.disabled ? 0 : importLeft, importLimit, key.disabled ? 'Key disabled' : `${importLeft} of ${importLimit} imports remaining this window`, !importLeft && !key.disabled)
    const status = row.querySelector<HTMLElement>('.key-status')!
    status.textContent = key.disabled ? 'Disabled' : share?.idle ? 'Idle' : 'Active'
    set('.key-last', key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never')
    row.querySelector<HTMLElement>('.key-last')!.title = key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never used'
    set('[data-action="toggle"]', key.disabled ? 'Enable' : 'Disable')
    row.querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.setAttribute('aria-label', `${button.textContent} ${key.label}`))
  }
}

function tick() {
  if (!snapshot || !token) return
  const s = snapshot.share
  const age = Math.max(0, Math.floor((Date.now() - receivedAt) / 1000))
  const seconds = Math.max(0, s.windowRemainingSec - age)
  text('resetTime', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)
  const stale = refreshFailed || !seconds || age >= 60
  $('snapshotStatus').dataset.state = stale ? 'stale' : 'fresh'
  text('snapshotStatus', refreshing ? 'Refreshing…' : refreshFailed ? 'Update failed · stale data' : !seconds ? 'Window ended · refresh' : `Updated ${age < 5 ? 'now' : `${age}s ago`}${stale ? ' · stale' : ''}`)
}

function refresh(): Promise<boolean> {
  if (refreshing) return refreshing
  if (!token || mutating) return Promise.resolve(false)
  const currentSession = session
  setBusy(true)
  text('snapshotStatus', 'Refreshing…')
  refreshing = (async () => {
    try {
      const [pool, keys, upstream] = await Promise.all([
        api<PoolView>('/api/admin/pool'),
        api<{ keys: ApiKeyView[]; defaultLimit: number; defaultImportLimit: number }>('/api/admin/keys'),
        api<{ upstreams: UpstreamView[] }>('/api/admin/upstream').catch(() => ({ upstreams: [] as UpstreamView[] })),
      ])
      currentSession.signal.throwIfAborted()
      snapshot = pool
      receivedAt = Date.now()
      refreshFailed = false
      $('dashboard').hidden = false
      renderPool(pool)
      renderUpstream(upstream.upstreams)
      input('newImportLimit').placeholder = String(keys.defaultImportLimit)
      renderKeys(keys.keys, pool.share.keys)
      message('appMsg')
      return true
    } catch (error) {
      if (currentSession.signal.aborted) return false
      refreshFailed = true
      message('appMsg', `${error instanceof Error ? error.message : 'Could not load the dashboard.'} Use Refresh to retry.`, true)
      text('snapshotStatus', snapshot ? 'Update failed · stale data' : 'Unavailable')
      $('snapshotStatus').dataset.state = 'stale'
      return false
    } finally {
      if (currentSession === session) { refreshing = undefined; setBusy(false); tick() }
    }
  })()
  return refreshing
}

async function mutate(fn: () => Promise<void>, target: string, success: string) {
  if (mutating || refreshing || !token) return
  const currentSession = session
  mutating = true
  setBusy(true)
  message(target)
  try {
    await fn()
    currentSession.signal.throwIfAborted()
    message(target, success)
    mutating = false
    await refresh()
  } catch (error) {
    if (!currentSession.signal.aborted) message(target, error instanceof Error ? error.message : 'Request failed. Try again.', true)
  } finally {
    if (currentSession === session) { mutating = false; setBusy(false) }
  }
}

function lock(reason = '') {
  session.abort()
  session = new AbortController()
  token = ''
  sessionStorage.removeItem(TOKEN_KEY)
  snapshot = undefined
  refreshing = undefined
  mutating = false
  keyRecords.clear()
  $('keys').replaceChildren()
  $('app').hidden = true
  $('dashboard').hidden = true
  $('sessionControls').hidden = true
  $('login').hidden = false
  $<HTMLDialogElement>('createDialog').close()
  $<HTMLDetailsElement>('settings').open = false
  $('secretBox').hidden = true
  text('secret', '')
  input('token').value = ''
  input('autoRefresh').checked = false
  $<HTMLFormElement>('createForm').reset()
  $<HTMLFormElement>('idleForm').reset()
  delete input('idleMinutes').dataset.dirty
  for (const id of ['appMsg', 'keysMsg', 'createMsg', 'idleMsg']) message(id)
  message('loginMsg', reason, true)
  setBusy(false)
  input('token').focus()
}

function showApp() {
  $('login').hidden = true
  $('app').hidden = false
  $('sessionControls').hidden = false
  void refresh()
}

$('loginForm').addEventListener('submit', (event) => {
  event.preventDefault()
  token = input('token').value.trim()
  if (!token) return
  sessionStorage.setItem(TOKEN_KEY, token)
  input('token').value = ''
  message('loginMsg')
  showApp()
})
$('lock').onclick = () => { lock() }
$('refresh').onclick = () => { void refresh() }
$('newKey').onclick = () => { $<HTMLDialogElement>('createDialog').showModal() }
$('closeDialog').onclick = () => { $<HTMLDialogElement>('createDialog').close() }
$('createDialog').addEventListener('cancel', (event) => { if (mutating) event.preventDefault() })
$('createDialog').addEventListener('close', () => {
  $('secretBox').hidden = true
  text('secret', '')
  text('createTitle', 'New key')
  $('createForm').hidden = false
  $<HTMLFormElement>('createForm').reset()
  message('createMsg')
})
input('idleMinutes').addEventListener('input', () => { input('idleMinutes').dataset.dirty = 'true' })
$('idleForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const minutes = Number(input('idleMinutes').value)
  void mutate(async () => {
    await api('/api/admin/pool', 'PATCH', { idleReleaseMinutes: minutes })
    if (Number(input('idleMinutes').value) === minutes) delete input('idleMinutes').dataset.dirty
  }, 'idleMsg', 'Idle reservation setting saved.')
})
$('createForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const label = input('newLabel').value
  const raw = input('newLimit').value.trim()
  const rawImport = input('newImportLimit').value.trim()
  void mutate(async () => {
    $('secretBox').hidden = true
    text('secret', '')
    const result = await api<{ secret: string }>('/api/admin/keys', 'POST', { label, limitPer15m: raw ? Number(raw) : undefined, importPer15m: rawImport ? Number(rawImport) : undefined })
    text('secret', result.secret)
    $('secretBox').hidden = false
    $('createForm').hidden = true
    text('createTitle', 'Key created')
    text('copySecret', 'Copy secret')
    $('copySecret').focus()
    if (input('newLabel').value === label) input('newLabel').value = ''
  }, 'createMsg', '')
})
$('copySecret').onclick = async () => {
  try { await navigator.clipboard.writeText($('secret').textContent || ''); text('copySecret', 'Copied') }
  catch { message('createMsg', 'Clipboard unavailable. Select and copy the secret above.', true) }
}
$('keys').addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')
  const row = button?.closest<HTMLTableRowElement>('tr[data-id]')
  const key = row && keyRecords.get(row.dataset.id!)
  if (!button || !row || !key || refreshing || mutating) return
  const action = button.dataset.action
  const limit = row.querySelector<HTMLInputElement>('.key-limit')!
  const importLimit = row.querySelector<HTMLInputElement>('.key-import-limit')!
  if (action === 'save' && !(limit.reportValidity() && importLimit.reportValidity())) return
  if (action === 'delete' && !confirm(`Delete key "${key.label}"? Requests using it will fail immediately.`)) return
  const nextLimit = Number(limit.value)
  const nextImportLimit = Number(importLimit.value)
  void mutate(async () => {
    if (action === 'delete') await api('/api/admin/keys', 'DELETE', { id: key.id })
    else await api('/api/admin/keys', 'PATCH', action === 'save' ? { id: key.id, limitPer15m: nextLimit, importPer15m: nextImportLimit } : { id: key.id, disabled: !key.disabled })
    if (action === 'save' && Number(limit.value) === nextLimit) delete limit.dataset.dirty
  }, 'keysMsg', action === 'delete' ? 'Key deleted.' : action === 'save' ? 'Allowance saved.' : `Key ${key.disabled ? 'enabled' : 'disabled'}.`)
})

setInterval(tick, 1000)
setInterval(() => { if (input('autoRefresh').checked && !document.hidden) void refresh() }, 30_000)
document.addEventListener('visibilitychange', () => { if (!document.hidden && input('autoRefresh').checked) void refresh() })
if (token) showApp()
