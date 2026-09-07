import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import posthog from 'posthog-js'

vi.mock('posthog-js', () => ({ default: { init: vi.fn(), capture: vi.fn() } }))

beforeEach(() => {
  vi.resetModules()
  vi.mocked(posthog.init).mockReset()
  vi.mocked(posthog.capture).mockReset()
  vi.stubEnv('PROD', true)
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://p.pcstyle.dev')
  vi.stubGlobal('window', { location: { pathname: '/', origin: 'https://x.pcstyle.dev', host: 'x.pcstyle.dev', href: 'https://x.pcstyle.dev/?secret=private-value' } })
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
