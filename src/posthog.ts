import posthog from 'posthog-js'

const posthogKey = import.meta.env.VITE_POSTHOG_KEY
const posthogHost = import.meta.env.VITE_POSTHOG_HOST
let enabled = false

const events = new Set(['$pageview', '$pageleave', 'conversion_requested', 'skill_install_command_copied'])
const properties = new Set([
  'token', 'distinct_id', '$device_id', '$session_id', '$window_id', '$pageview_id',
  '$browser', '$browser_version', '$os', '$os_version', '$device_type',
  '$screen_height', '$screen_width', '$viewport_height', '$viewport_width',
  '$lib', '$lib_version', '$is_identified', '$pageleave_reason',
  '$prev_pageview_id', '$prev_pageview_duration',
])

if (import.meta.env.PROD && import.meta.env.VERCEL_ENV === 'production' && posthogKey && posthogHost?.startsWith('https://') && window.location.pathname === '/') {
  try {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      ui_host: 'https://eu.posthog.com',
      defaults: '2026-05-30',
      persistence: 'localStorage',
      person_profiles: 'never',
      autocapture: false,
      capture_pageview: true,
      capture_pageleave: true,
      capture_exceptions: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      enable_heatmaps: false,
      before_send(event) {
        if (!event || !events.has(event.event) || window.location.pathname !== '/') return null
        // Keep session/browser metrics, not SDK-enriched URLs, referrers or user data.
        event.properties = Object.fromEntries(Object.entries(event.properties).filter(([key]) => properties.has(key)))
        Object.assign(event.properties, {
          $current_url: `${window.location.origin}/`,
          $host: window.location.host,
          $pathname: '/',
          $process_person_profile: false,
          $geoip_disable: true,
          $ip: null,
          route: 'landing',
          environment: 'production',
        })
        delete event.$set
        delete event.$set_once
        return event
      },
    })
    enabled = true
  } catch {
    // Optional analytics must not stop the landing page from loading.
  }
}

export function captureLandingEvent(event: 'conversion_requested' | 'skill_install_command_copied') {
  if (!enabled || window.location.pathname !== '/' || !events.has(event)) return
  try { posthog.capture(event) } catch { /* Keep the interaction working if analytics fails. */ }
}
