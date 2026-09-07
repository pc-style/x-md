import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import posthog from 'posthog-js'

vi.mock('posthog-js', () => ({ default: {
  init: vi.fn(), capture: vi.fn(), get_distinct_id: vi.fn(),
  get_property: vi.fn(), has_opted_out_capturing: vi.fn(),
} }))

const actorId = '019abcde-1234-7123-8123-123456789abc'
let cookies: Map<string, string>
let cookieWrites: string[]

beforeEach(() => {
  vi.resetModules()
  vi.mocked(posthog.init).mockReset()
  vi.mocked(posthog.capture).mockReset()
  vi.mocked(posthog.get_distinct_id).mockReset().mockReturnValue(actorId)
  vi.mocked(posthog.get_property).mockReset().mockReturnValue(undefined)
  vi.mocked(posthog.has_opted_out_capturing).mockReset().mockReturnValue(false)
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', '')
  vi.stubGlobal('navigator', { doNotTrack: '0', globalPrivacyControl: false })
  cookies = new Map()
  cookieWrites = []
  vi.stubGlobal('document', {
    get cookie() { return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') },
    set cookie(value: string) {
      cookieWrites.push(value)
      const [name, content] = value.split(';')[0].split('=')
      if (value.includes('Max-Age=0')) cookies.delete(name)
      else cookies.set(name, content)
    },
  })
  vi.stubEnv('PROD', true)
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://p.pcstyle.dev')
  vi.stubGlobal('window', { location: { protocol: 'https:', pathname: '/', origin: 'https://x.pcstyle.dev', host: 'x.pcstyle.dev', href: 'https://x.pcstyle.dev/?secret=private-value' } })
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

test('enables pageviews through the proxy without replay or automatic content capture', async () => {
  const { captureLandingEvent } = await import('./posthog')
  expect(posthog.init).toHaveBeenCalledWith('phc_test', expect.objectContaining({
    api_host: 'https://p.pcstyle.dev', ui_host: 'https://eu.posthog.com',
    capture_pageview: true, capture_pageleave: true, persistence: 'localStorage',
    person_profiles: 'never', autocapture: false, capture_exceptions: false,
    disable_session_recording: true, capture_performance: false, enable_heatmaps: false,
  }))
  captureLandingEvent('conversion_requested')
  captureLandingEvent('skill_install_command_copied')
  expect(vi.mocked(posthog.capture).mock.calls.map(call => call[0])).toEqual(['conversion_requested', 'skill_install_command_copied'])
})

test('sanitizes URLs and user properties while preserving session metrics', async () => {
  await import('./posthog')
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  const result = beforeSend({ event: '$pageview', properties: {
    token: 'phc_test', distinct_id: 'anonymous-device', $session_id: 'session', $browser: 'Chrome',
    $current_url: window.location.href, $referrer: 'private-referrer', $initial_current_url: window.location.href,
    $set: { email: 'private-email' }, form_content: 'private-form',
  }, $set: { email: 'private-email' }, $set_once: { name: 'private-name' } })
  expect(result.properties).toMatchObject({ token: 'phc_test', distinct_id: 'anonymous-device', $session_id: 'session', $browser: 'Chrome',
    $current_url: 'https://x.pcstyle.dev/', $host: 'x.pcstyle.dev', $pathname: '/', $ip: null, $process_person_profile: false })
  expect(JSON.stringify(result)).not.toContain('private-')
  expect(beforeSend({ event: '$autocapture', properties: {} })).toBeNull()
  expect(beforeSend({ event: '$exception', properties: {} })).toBeNull()
  window.location.pathname = '/admin'
  expect(beforeSend({ event: '$pageview', properties: {} })).toBeNull()
})

test.each(['/admin', '/admin.html', '/docs', '/search'])('does not initialize on %s', async (pathname) => {
  window.location.pathname = pathname
  const { captureLandingEvent } = await import('./posthog')
  captureLandingEvent('conversion_requested')
  expect(posthog.init).not.toHaveBeenCalled()
  expect(posthog.capture).not.toHaveBeenCalled()
})

test.each([
  ['PROD', false], ['VERCEL_ENV', 'preview'], ['VERCEL_ENV', 'development'],
  ['VITE_POSTHOG_KEY', ''], ['VITE_POSTHOG_HOST', ''], ['VITE_POSTHOG_HOST', 'http://example.test'],
] as const)('ignores disabled or incomplete configuration: %s=%s', async (name, value) => {
  vi.stubEnv(name, value)
  const { captureLandingEvent } = await import('./posthog')
  captureLandingEvent('conversion_requested')
  expect(posthog.init).not.toHaveBeenCalled()
  expect(posthog.capture).not.toHaveBeenCalled()
})

test('analytics failures do not interrupt loading or interactions', async () => {
  vi.mocked(posthog.init).mockImplementation(() => { throw new Error('blocked') })
  const disabled = await import('./posthog')
  expect(() => disabled.captureLandingEvent('conversion_requested')).not.toThrow()
  expect(posthog.capture).not.toHaveBeenCalled()
  vi.resetModules()
  vi.mocked(posthog.init).mockReset()
  const enabled = await import('./posthog')
  vi.mocked(posthog.capture).mockImplementation(() => { throw new Error('blocked') })
  expect(() => enabled.captureLandingEvent('conversion_requested')).not.toThrow()
})

function loaded() {
  const options = vi.mocked(posthog.init).mock.calls[0][1]!
  options.loaded!(posthog)
}

test('bridge is disabled by default without changing ordinary analytics', async () => {
  const { captureLandingEvent } = await import('./posthog')
  loaded()
  captureLandingEvent('conversion_requested')
  expect(cookieWrites).toEqual([])
  expect(posthog.get_distinct_id).not.toHaveBeenCalled()
})

test('bridges anonymous identity on loaded and refreshes it before conversion', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await import('./posthog')
  loaded()
  expect(cookieWrites).toEqual([`__Host-xmd_actor=${encodeURIComponent(actorId)}; Secure; SameSite=Lax; Path=/; Max-Age=2592000`])
  const freshId = '019abcde-1234-7123-8123-123456789abd'
  vi.mocked(posthog.get_distinct_id).mockReturnValue(freshId)
  vi.mocked(posthog.capture).mockImplementation(() => {
    expect(cookies.get('__Host-xmd_actor')).toBe(freshId)
    return undefined
  })
  captureLandingEvent('conversion_requested')
  expect(posthog.capture).toHaveBeenCalledWith('conversion_requested')
  expect(window.location.href).not.toContain(actorId)
})

test.each(['false', 'TRUE', '1'])('requires exact bridge flag: %s', async value => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', value)
  await import('./posthog')
  loaded()
  expect(cookieWrites).toEqual([])
})

test('never writes bridge cookies on HTTP', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  window.location.protocol = 'http:'
  const { captureLandingEvent } = await import('./posthog')
  loaded()
  captureLandingEvent('conversion_requested')
  expect(cookieWrites).toEqual([])
})

test.each(['email@example.com', 'user-123', '', '019abcde-1234-7123-8123-123456789abc;other=1'])('clears non-anonymous ID %s', async id => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  vi.mocked(posthog.get_distinct_id).mockReturnValue(id)
  await import('./posthog')
  loaded()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test.each([['$user_id', actorId], ['$is_identified', true], ['$user_state', 'identified']] as const)('does not bridge identified UUID (%s)', async (property, value) => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  vi.mocked(posthog.get_property).mockImplementation(key => key === property ? value : undefined)
  await import('./posthog')
  loaded()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

function blockPrivacy(signal: string) {
  if (signal === 'cookie') cookies.set('__Host-xmd_archive_optout', '1')
  else if (signal === 'DNT') vi.stubGlobal('navigator', { doNotTrack: '1' })
  else vi.stubGlobal('navigator', { globalPrivacyControl: true })
}

test.each(['cookie', 'DNT', 'GPC'])('honors %s before initialization and removes stale actor', async signal => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  blockPrivacy(signal)
  const { captureLandingEvent } = await import('./posthog')
  captureLandingEvent('conversion_requested')
  expect(posthog.init).not.toHaveBeenCalled()
  expect(posthog.capture).not.toHaveBeenCalled()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test.each(['cookie', 'DNT', 'GPC'])('honors new %s before conversion', async signal => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await import('./posthog')
  loaded()
  blockPrivacy(signal)
  captureLandingEvent('conversion_requested')
  expect(posthog.capture).not.toHaveBeenCalled()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test('SDK opt-out clears actor before conversion', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await import('./posthog')
  loaded()
  vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(true)
  captureLandingEvent('conversion_requested')
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
  expect(cookieWrites.at(-1)).toBe('__Host-xmd_actor=; Secure; SameSite=Lax; Path=/; Max-Age=0')
  expect(cookieWrites).toContain('__Host-xmd_archive_optout=1; Secure; SameSite=Lax; Path=/; Max-Age=2592000')
  vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(false)
  captureLandingEvent('conversion_requested')
  expect(cookies.get('__Host-xmd_archive_optout')).toBe('1')
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test('SDK bridge failures clear stale identity without breaking conversion', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await import('./posthog')
  loaded()
  vi.mocked(posthog.get_distinct_id).mockImplementation(() => { throw new Error('blocked') })
  expect(() => captureLandingEvent('conversion_requested')).not.toThrow()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
  expect(posthog.capture).toHaveBeenCalledWith('conversion_requested')
})


test.each(['cookie', 'DNT', 'GPC'])('before_send honors new %s for automatic events', async signal => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  await import('./posthog')
  loaded()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  blockPrivacy(signal)
  expect(beforeSend({ event: '$pageview', properties: {} })).toBeNull()
  expect(beforeSend({ event: '$pageleave', properties: {} })).toBeNull()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test('mirrors existing SDK optout when the SDK loads', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  vi.mocked(posthog.has_opted_out_capturing).mockReturnValue(true)
  await import('./posthog')
  loaded()
  expect(cookies.get('__Host-xmd_archive_optout')).toBe('1')
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})
