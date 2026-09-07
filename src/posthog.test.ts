import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('PROD', true)
  vi.stubEnv('VERCEL_ENV', 'production')
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test')
  vi.stubEnv('VITE_POSTHOG_HOST', 'https://eu.i.posthog.com/')
  vi.stubGlobal('window', { location: { pathname: '/', href: 'https://example.test/?secret=private-value' } })
  vi.stubGlobal('fetch', fetchMock.mockReset().mockResolvedValue(new Response('{}')))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

test('only sends manual events with fixed properties and no persistent identity', async () => {
  const { captureLandingEvent } = await import('./posthog')
  expect(fetchMock).not.toHaveBeenCalled()
  captureLandingEvent('conversion_requested')
  captureLandingEvent('skill_install_command_copied')
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const events = fetchMock.mock.calls.map(([url, options]) => {
    expect(url).toBe('https://eu.i.posthog.com/i/v0/e/')
    expect(options).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', keepalive: true })
    const event = JSON.parse(options.body)
    expect(event.properties).toEqual({ route: 'landing', environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null })
    expect(event.distinct_id).toBe(`anonymous:${event.uuid}`)
    expect(options.body).not.toContain('private-value')
    return event
  })
  expect(events.map(event => event.event)).toEqual(['conversion_requested', 'skill_install_command_copied'])
  expect(events[0].distinct_id).not.toBe(events[1].distinct_id)
})

test.each(['/admin', '/admin.html', '/docs', '/search'])('does not capture on %s', async (pathname) => {
  window.location.pathname = pathname
  const { captureLandingEvent } = await import('./posthog')
  captureLandingEvent('conversion_requested')
  expect(fetchMock).not.toHaveBeenCalled()
})

test.each([
  ['PROD', false], ['VERCEL_ENV', 'preview'], ['VERCEL_ENV', 'development'],
  ['VITE_POSTHOG_KEY', ''], ['VITE_POSTHOG_HOST', ''], ['VITE_POSTHOG_HOST', 'http://example.test'],
] as const)('ignores disabled or incomplete configuration: %s=%s', async (name, value) => {
  vi.stubEnv(name, value)
  const { captureLandingEvent } = await import('./posthog')
  captureLandingEvent('conversion_requested')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('rejects unexpected runtime event names', async () => {
  const { captureLandingEvent } = await import('./posthog')
  // @ts-expect-error Runtime input must also obey the event allowlist.
  captureLandingEvent('admin_access_granted')
  expect(fetchMock).not.toHaveBeenCalled()
})

test('analytics failures do not interrupt the interaction', async () => {
  const { captureLandingEvent } = await import('./posthog')
  fetchMock.mockRejectedValue(new Error('offline'))
  expect(() => captureLandingEvent('conversion_requested')).not.toThrow()
  await Promise.resolve()
  fetchMock.mockImplementation(() => { throw new Error('blocked') })
  expect(() => captureLandingEvent('conversion_requested')).not.toThrow()
})
