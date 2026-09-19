import posthog from 'posthog-js'

const posthogKey = import.meta.env.VITE_POSTHOG_KEY
const posthogHost = import.meta.env.VITE_POSTHOG_HOST
let enabled = false
const actorBridgeEnabled = import.meta.env.VITE_XMD_ARCHIVE_ACTOR_BRIDGE === 'true'
const actorCookie = '__Host-xmd_actor'
const anonymousId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function privacyBlocked() {
  const browser = navigator as Navigator & { globalPrivacyControl?: boolean }
  return browser.doNotTrack === '1' || browser.doNotTrack === 'yes'
    || browser.globalPrivacyControl === true
    || document.cookie.split(';').some(cookie => cookie.trim() === '__Host-xmd_archive_optout=1')
}

function clearActor() {
  if (window.location.protocol === 'https:') {
    document.cookie = `${actorCookie}=; Secure; SameSite=Lax; Path=/; Max-Age=0`
  }
}

function bridgeActor() {
  if (window.location.protocol !== 'https:') return
  try {
    if (!actorBridgeEnabled) { clearActor(); return }
    if (posthog.has_opted_out_capturing()) {
      document.cookie = '__Host-xmd_archive_optout=1; Secure; SameSite=Lax; Path=/; Max-Age=2592000'
      clearActor()
      return
    }
    const id = posthog.get_distinct_id()
    // Identified IDs can also look like UUIDs. Check persisted identity state too.
    if (privacyBlocked()
      || posthog.get_property('$user_id') != null
      || posthog.get_property('$is_identified') === true
      || posthog.get_property('$user_state') === 'identified'
      || typeof id !== 'string' || !anonymousId.test(id)) {
      clearActor()
      return
    }
    document.cookie = `${actorCookie}=${encodeURIComponent(id)}; Secure; SameSite=Lax; Path=/; Max-Age=2592000`
  } catch {
    // Storage or SDK access can fail. Never keep a stale identity in that case.
    try { clearActor() } catch { /* Cookies may be blocked. */ }
  }
}

let blocked = true
try {
  // A previous enabled build may have left an actor cookie behind. Clean up
  // even when configuration prevents the SDK from initializing.
  if (!actorBridgeEnabled) clearActor()
  blocked = privacyBlocked()
  if (blocked) clearActor()
} catch { /* Fail closed when privacy settings cannot be read. */ }

const events = new Set(['$pageview', '$pageleave', '$web_vitals', 'conversion_requested', 'skill_install_command_copied'])
const properties = new Set([
  'token', 'distinct_id', '$device_id', '$session_id', '$window_id', '$pageview_id',
  '$browser', '$browser_version', '$os', '$os_version', '$device_type',
  '$screen_height', '$screen_width', '$viewport_height', '$viewport_width',
  '$lib', '$lib_version', '$lib_custom_api_host', '$is_identified', '$pageleave_reason',
  '$prev_pageview_id', '$prev_pageview_duration', '$prev_pageview_pathname',
  '$prev_pageview_max_content_percentage', '$prev_pageview_max_scroll_percentage',
  '$web_vitals_FCP_value', '$web_vitals_FCP_event',
  '$web_vitals_LCP_value', '$web_vitals_LCP_event',
  '$web_vitals_INP_value', '$web_vitals_INP_event',
  '$web_vitals_CLS_value', '$web_vitals_CLS_event',
])
const webVitalEventProperties = new Set(['name', 'value', 'rating', 'delta', 'navigationType'])
const webVitalEventKeys = ['$web_vitals_FCP_event', '$web_vitals_LCP_event', '$web_vitals_INP_event', '$web_vitals_CLS_event']

function sanitizeWebVitalEvents(eventProperties: Record<string, unknown>) {
  for (const key of webVitalEventKeys) {
    const value = eventProperties[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) { delete eventProperties[key]; continue }
    eventProperties[key] = Object.fromEntries(Object.entries(value)
      .filter(([property, content]) => webVitalEventProperties.has(property)
        && ['string', 'number', 'boolean'].includes(typeof content)))
  }
}

if (!blocked && import.meta.env.PROD && import.meta.env.VERCEL_ENV === 'production' && posthogKey && posthogHost?.startsWith('https://') && window.location.pathname === '/') {
  try {
    posthog.init(posthogKey, {
      api_host: posthogHost,
      loaded: () => bridgeActor(),
      ui_host: 'https://eu.posthog.com',
      defaults: '2026-05-30',
      persistence: 'localStorage',
      person_profiles: 'never',
      // Keep scroll-depth collection active without capturing clicks, forms, or DOM content.
      autocapture: { dom_event_allowlist: [] },
      capture_pageview: true,
      capture_pageleave: true,
      capture_exceptions: false,
      capture_performance: { web_vitals: true, web_vitals_attribution: false },
      disable_session_recording: true,
      disable_surveys: true,
      enable_heatmaps: false,
      before_send(event) {
        try {
          if (privacyBlocked()) { clearActor(); return null }
        } catch { return null }
        if (!event || !events.has(event.event) || window.location.pathname !== '/') return null
        // Keep session/browser metrics, not SDK-enriched URLs, referrers or user data.
        event.properties = Object.fromEntries(Object.entries(event.properties).filter(([key]) => properties.has(key)))
        if (event.event === '$web_vitals') sanitizeWebVitalEvents(event.properties)
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
  try {
    if (privacyBlocked()) { clearActor(); return }
    if (event === 'conversion_requested') bridgeActor()
    posthog.capture(event)
  } catch { /* Keep the interaction working if analytics fails. */ }
}
