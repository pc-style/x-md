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
  vi.doMock('posthog-js', () => ({ default: posthog }))
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
  vi.stubGlobal('window', { location: { protocol: 'https:', pathname: '/', origin: 'https://mdfromx.com', host: 'mdfromx.com', href: 'https://mdfromx.com/?secret=private-value' } })
})

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

async function loadAnalytics() {
  const module = await import('./posthog')
  await module.analyticsReady
  return module
}

test('a returning visitor keeps the actor cookie when converting during SDK download', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.doMock('posthog-js', async () => { await gate; return { default: posthog } })
  const module = await import('./posthog')
  try {
    module.captureLandingEvent('conversion_requested')
    expect(posthog.init).not.toHaveBeenCalled()
    expect(posthog.capture).not.toHaveBeenCalled()
    expect(cookies.get('__Host-xmd_actor')).toBe(actorId)
    expect(cookieWrites).toEqual([])
  } finally {
    release()
    await module.analyticsReady
  }
  expect(posthog.capture).toHaveBeenCalledWith('conversion_requested')
  expect(cookies.get('__Host-xmd_actor')).toBe(actorId)
})

test.each(['download', 'initialization'])('a failed SDK %s clears the pending actor cookie', async failure => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  if (failure === 'download') vi.doMock('posthog-js', async () => { throw new Error('unavailable') })
  else vi.mocked(posthog.init).mockImplementation(() => { throw new Error('unavailable') })
  const module = await loadAnalytics()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
  module.captureLandingEvent('conversion_requested')
  expect(posthog.capture).not.toHaveBeenCalled()
})

test('enables web analytics through the proxy without replay or interaction capture', async () => {
  const { captureLandingEvent } = await loadAnalytics()
  expect(posthog.init).toHaveBeenCalledWith('phc_test', expect.objectContaining({
    api_host: 'https://p.pcstyle.dev', ui_host: 'https://eu.posthog.com',
    capture_pageview: 'history_change', capture_pageleave: true, persistence: 'localStorage',
    person_profiles: 'never', autocapture: { dom_event_allowlist: [] }, capture_exceptions: true,
    disable_session_recording: true,
    capture_performance: { web_vitals: true, web_vitals_attribution: false }, enable_heatmaps: false,
  }))
  captureLandingEvent('conversion_requested')
  captureLandingEvent('skill_install_command_copied')
  expect(vi.mocked(posthog.capture).mock.calls.map(call => call[0])).toEqual(['conversion_requested', 'skill_install_command_copied'])
})

test('sanitizes URLs and user properties while preserving session metrics', async () => {
  await loadAnalytics()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  const result = beforeSend({ event: '$pageview', properties: {
    token: 'phc_test', distinct_id: 'anonymous-device', $session_id: 'session', $browser: 'Chrome',
    $lib_custom_api_host: 'https://p.pcstyle.dev',
    $current_url: window.location.href, $referrer: 'https://news.example/private-path?private=1', $initial_current_url: window.location.href,
    $referring_domain: 'news.example', utm_source: 'newsletter', utm_campaign: 'launch', utm_term: 42,
    gclid: 'private-click-id', $initial_referrer: 'not a url private-text', $initial_utm_medium: 'email',
    $set: { email: 'private-email' }, form_content: 'private-form',
  }, $set: { email: 'private-email' }, $set_once: { name: 'private-name' } })
  expect(result.properties).toMatchObject({ token: 'phc_test', distinct_id: 'anonymous-device', $session_id: 'session', $browser: 'Chrome',
    $lib_custom_api_host: 'https://p.pcstyle.dev',
    $current_url: 'https://mdfromx.com/', $host: 'mdfromx.com', $pathname: '/', $ip: null, $process_person_profile: false,
    $referrer: 'https://news.example', $referring_domain: 'news.example', utm_source: 'newsletter', utm_campaign: 'launch',
    $initial_utm_medium: 'email', route: 'landing' })
  expect(result.properties).not.toHaveProperty('utm_term')
  expect(result.properties).not.toHaveProperty('$initial_referrer')
  expect(JSON.stringify(result)).not.toContain('private')

  const pageleave = beforeSend({ event: '$pageleave', properties: {
    $prev_pageview_max_content_percentage: 0.75,
    $prev_pageview_max_scroll_percentage: 0.8,
    $prev_pageview_pathname: '/',
    $current_url: `${window.location.href}private`,
  } })
  expect(pageleave.properties).toMatchObject({
    $prev_pageview_max_content_percentage: 0.75,
    $prev_pageview_max_scroll_percentage: 0.8,
    $prev_pageview_pathname: '/',
  })

  const webVitals = beforeSend({ event: '$web_vitals', properties: {
    $web_vitals_LCP_value: 1234,
    $web_vitals_LCP_event: {
      name: 'LCP', value: 1234, rating: 'good', delta: 12, navigationType: 'navigate',
      attribution: { target: '#private-button', url: 'https://example.test/private' },
      entries: [{ url: 'https://example.test/private-entry' }],
    },
    private_metric: 'private-value',
  } })
  expect(webVitals.properties).toMatchObject({
    $web_vitals_LCP_value: 1234,
    $web_vitals_LCP_event: { name: 'LCP', value: 1234, rating: 'good', delta: 12, navigationType: 'navigate' },
  })
  expect(JSON.stringify(webVitals)).not.toContain('private')
  expect(beforeSend({ event: '$autocapture', properties: {} })).toBeNull()
  expect(beforeSend({ event: '$pageview', properties: { $exception_list: [{ value: 'private' }] } }).properties)
    .not.toHaveProperty('$exception_list')
  window.location.pathname = '/admin'
  expect(beforeSend({ event: '$pageview', properties: {} })).toBeNull()
})

test('sanitizes exceptions to their type, message, and stack frames', async () => {
  await loadAnalytics()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  const result = beforeSend({ event: '$exception', properties: {
    $release_id: 'test-release',
    $exception_level: 'error',
    $exception_message: 'Failed to fetch https://mdfromx.com/api/v1/posts?url=private-query#private-hash',
    $exception_steps: [{ $message: 'private-step' }],
    $exception_list: [{
      type: 'TypeError',
      value: 'Failed to fetch https://mdfromx.com/api/v1/posts?url=private-query#private-hash',
      mechanism: { type: 'onerror', handled: false, synthetic: false, source: 'private-source' },
      private_extra: 'private-extra',
      stacktrace: { type: 'raw', frames: [{
        platform: 'web:javascript', filename: 'https://mdfromx.com/docs/analytics.js?v=private-version',
        function: 'load', lineno: 1, colno: 22, in_app: true,
        chunk_id: '75197da3-6b4e-5a73-a7ff-e524feff0acc',
        context_line: 'private-source-line', vars: { token: 'private-var' },
      }] },
    }],
    $sentry_exception: 'private-sentry',
  } })
  expect(result.properties).toMatchObject({
    $release_id: 'test-release',
    $exception_level: 'error',
    $exception_message: 'Failed to fetch https://mdfromx.com/api/v1/posts',
    $exception_list: [{
      type: 'TypeError',
      value: 'Failed to fetch https://mdfromx.com/api/v1/posts',
      mechanism: { type: 'onerror', handled: false, synthetic: false },
      stacktrace: { type: 'raw', frames: [{
        platform: 'web:javascript', filename: 'https://mdfromx.com/docs/analytics.js',
        function: 'load', lineno: 1, colno: 22, in_app: true,
        chunk_id: '75197da3-6b4e-5a73-a7ff-e524feff0acc',
      }] },
    }],
  })
  expect(JSON.stringify(result)).not.toContain('private')
})

test.each([
  ['https://example.com/a(b)?token=private#private', 'https://example.com/a(b)'],
  ['https://example.com/search?q=(private)#private', 'https://example.com/search'],
  ['/docs/self-hosting?secret=private#private', '/docs/self-hosting'],
  ['docs/analytics.js?v=private', 'docs/analytics.js'],
  ['https://x.test/a(?token=private', 'https://x.test/a('],
  ['/docs/(#private', '/docs/('],
  ['fetch(?x=private)', 'fetch('],
  ['?token=private', ''],
  ['#private', ''],
  ["'?token=private'", "''"],
  ['"?token=private"', '""'],
  ["https://example.test/?name=O'Brien&token=private", 'https://example.test/'],
  ["'https://example.test/?name=O'Brien&token=private'", "'https://example.test/'"],
  ["?name=O'Brien&token=private", ''],
])('strips the query and fragment from %s in exception text and frames', async (url, kept) => {
  await loadAnalytics()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  const result = beforeSend({ event: '$exception', properties: {
    $exception_message: `Failed to fetch ${url} (status 0)`,
    $exception_list: [{ type: 'TypeError', value: `at ${url}`, stacktrace: { type: 'raw', frames: [
      { filename: url, abs_path: url, lineno: 1 },
      { filename: 'https://mdfromx.com/assets/main.js', lineno: 1 },
    ] } }],
  } })
  expect(result.properties.$exception_message).toBe(`Failed to fetch ${kept} (status 0)`)
  expect(result.properties.$exception_list[0].value).toBe(`at ${kept}`)
  expect(JSON.stringify(result)).not.toContain('private')
})

test.each([
  ['an in-app browser script', 'TypeError', "undefined is not an object (evaluating 'window.webkit.messageHandlers')", [{ filename: 'user-script:3', lineno: 1 }]],
  ['an injected global', 'ReferenceError', "Can't find variable: CONFIG", [{ filename: '<anonymous>', lineno: 1 }]],
  ['a lookalike origin', 'TypeError', 'boom', [{ filename: 'https://mdfromx.com.evil.test/a.js', lineno: 1 }]],
  ['an extension', 'TypeError', 'boom', [{ filename: 'chrome-extension://abc/content.js', lineno: 1 }]],
  ['a stackless error', 'Error', 'Script error.', undefined],
  ['the ResizeObserver loop notice', 'Error', 'ResizeObserver loop completed with undelivered notifications.', [{ filename: 'https://mdfromx.com/assets/module.js', lineno: 1 }]],
])('drops an exception from %s', async (_, type, value, frames) => {
  await loadAnalytics()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  expect(beforeSend({ event: '$exception', properties: {
    $exception_list: [{ type, value, ...(frames && { stacktrace: { type: 'raw', frames } }) }],
  } })).toBeNull()
})

test('keeps an exception that passes through this origin\'s scripts', async () => {
  await loadAnalytics()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  const result = beforeSend({ event: '$exception', properties: {
    $exception_list: [{ type: 'TypeError', value: "Cannot read properties of null (reading 'querySelectorAll')", stacktrace: { type: 'raw', frames: [
      { filename: 'chrome-extension://abc/content.js', lineno: 1 },
      { filename: 'https://mdfromx.com/assets/tabs-B8keuXVz.js', lineno: 2, colno: 1147 },
    ] } }],
  } })
  expect(result.properties.$exception_list[0].value).toBe("Cannot read properties of null (reading 'querySelectorAll')")
})

test('reports the docs page path without its query string', async () => {
  window.location.pathname = '/docs/self-hosting'
  window.location.href = 'https://mdfromx.com/docs/self-hosting?secret=private-value#private-hash'
  const { captureLandingEvent } = await loadAnalytics()
  expect(posthog.init).toHaveBeenCalled()
  const beforeSend = vi.mocked(posthog.init).mock.calls[0][1]!.before_send as (event: any) => any
  const result = beforeSend({ event: '$pageview', properties: { $current_url: window.location.href, $pathname: '/docs/self-hosting' } })
  expect(result.properties).toMatchObject({
    $current_url: 'https://mdfromx.com/docs/self-hosting', $pathname: '/docs/self-hosting', route: 'docs',
  })
  expect(JSON.stringify(result)).not.toContain('private')
  // The landing interactions stay landing-only.
  captureLandingEvent('conversion_requested')
  expect(posthog.capture).not.toHaveBeenCalled()
})

test.each(['/admin', '/admin.html', '/docsearch', '/search', '/about', '/privacy'])('does not initialize on %s', async (pathname) => {
  window.location.pathname = pathname
  const { captureLandingEvent } = await loadAnalytics()
  captureLandingEvent('conversion_requested')
  expect(posthog.init).not.toHaveBeenCalled()
  expect(posthog.capture).not.toHaveBeenCalled()
})

test.each([
  ['PROD', false], ['VERCEL_ENV', 'preview'], ['VERCEL_ENV', 'development'],
  ['VITE_POSTHOG_KEY', ''], ['VITE_POSTHOG_HOST', ''], ['VITE_POSTHOG_HOST', 'http://example.test'],
] as const)('ignores disabled or incomplete configuration: %s=%s', async (name, value) => {
  vi.stubEnv(name, value)
  const { captureLandingEvent } = await loadAnalytics()
  captureLandingEvent('conversion_requested')
  expect(posthog.init).not.toHaveBeenCalled()
  expect(posthog.capture).not.toHaveBeenCalled()
})

test('analytics failures do not interrupt loading or interactions', async () => {
  vi.mocked(posthog.init).mockImplementation(() => { throw new Error('blocked') })
  const disabled = await loadAnalytics()
  expect(() => disabled.captureLandingEvent('conversion_requested')).not.toThrow()
  expect(posthog.capture).not.toHaveBeenCalled()
  vi.resetModules()
  vi.mocked(posthog.init).mockReset()
  const enabled = await loadAnalytics()
  vi.mocked(posthog.capture).mockImplementation(() => { throw new Error('blocked') })
  expect(() => enabled.captureLandingEvent('conversion_requested')).not.toThrow()
})

function loaded() {
  const options = vi.mocked(posthog.init).mock.calls[0][1]!
  options.loaded!(posthog)
}

test('bridge is disabled by default without changing ordinary analytics', async () => {
  const { captureLandingEvent } = await loadAnalytics()
  loaded()
  captureLandingEvent('conversion_requested')
  expect(cookieWrites.length).toBeGreaterThan(0)
  expect(cookieWrites.every(cookie => cookie.includes('Max-Age=0'))).toBe(true)
  expect(posthog.get_distinct_id).not.toHaveBeenCalled()
})

test('bridges anonymous identity on loaded and refreshes it before conversion', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await loadAnalytics()
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
  await loadAnalytics()
  loaded()
  expect(cookieWrites.length).toBeGreaterThan(0)
  expect(cookieWrites.every(cookie => cookie.includes('Max-Age=0'))).toBe(true)
})

test('never writes bridge cookies on HTTP', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  window.location.protocol = 'http:'
  const { captureLandingEvent } = await loadAnalytics()
  loaded()
  captureLandingEvent('conversion_requested')
  expect(cookieWrites).toEqual([])
})

test.each(['email@example.com', 'user-123', '', '019abcde-1234-7123-8123-123456789abc;other=1'])('clears non-anonymous ID %s', async id => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  vi.mocked(posthog.get_distinct_id).mockReturnValue(id)
  await loadAnalytics()
  loaded()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test.each([['$user_id', actorId], ['$is_identified', true], ['$user_state', 'identified']] as const)('does not bridge identified UUID (%s)', async (property, value) => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  cookies.set('__Host-xmd_actor', actorId)
  vi.mocked(posthog.get_property).mockImplementation(key => key === property ? value : undefined)
  await loadAnalytics()
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
  const { captureLandingEvent } = await loadAnalytics()
  captureLandingEvent('conversion_requested')
  expect(posthog.init).not.toHaveBeenCalled()
  expect(posthog.capture).not.toHaveBeenCalled()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test.each(['cookie', 'DNT', 'GPC'])('honors new %s before conversion', async signal => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await loadAnalytics()
  loaded()
  blockPrivacy(signal)
  captureLandingEvent('conversion_requested')
  expect(posthog.capture).not.toHaveBeenCalled()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})

test('SDK opt-out clears actor before conversion', async () => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  const { captureLandingEvent } = await loadAnalytics()
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
  const { captureLandingEvent } = await loadAnalytics()
  loaded()
  vi.mocked(posthog.get_distinct_id).mockImplementation(() => { throw new Error('blocked') })
  expect(() => captureLandingEvent('conversion_requested')).not.toThrow()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
  expect(posthog.capture).toHaveBeenCalledWith('conversion_requested')
})


test.each(['cookie', 'DNT', 'GPC'])('before_send honors new %s for automatic events', async signal => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  await loadAnalytics()
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
  await loadAnalytics()
  loaded()
  expect(cookies.get('__Host-xmd_archive_optout')).toBe('1')
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
})


test.each([true, false])('disabling an enabled bridge clears its actor even with SDK available=%s', async sdkAvailable => {
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'true')
  await loadAnalytics()
  loaded()
  expect(cookies.get('__Host-xmd_actor')).toBe(actorId)
  vi.resetModules()
  vi.mocked(posthog.init).mockClear()
  vi.mocked(posthog.get_distinct_id).mockClear()
  vi.stubEnv('VITE_XMD_ARCHIVE_ACTOR_BRIDGE', 'false')
  if (!sdkAvailable) vi.stubEnv('VITE_POSTHOG_KEY', '')
  await loadAnalytics()
  expect(cookies.has('__Host-xmd_actor')).toBe(false)
  expect(cookieWrites.at(-1)).toBe('__Host-xmd_actor=; Secure; SameSite=Lax; Path=/; Max-Age=0')
  expect(posthog.get_distinct_id).not.toHaveBeenCalled()
  if (!sdkAvailable) expect(posthog.init).not.toHaveBeenCalled()
})
