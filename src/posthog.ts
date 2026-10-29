import type { PostHog } from 'posthog-js'

let posthog: PostHog | undefined
type LandingEvent = 'conversion_requested' | 'skill_install_command_copied'
const pendingEvents: LandingEvent[] = []

const posthogKey = import.meta.env.VITE_POSTHOG_KEY
const posthogHost = import.meta.env.VITE_POSTHOG_HOST
let enabled = false
let analyticsFailed = false
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
    if (!posthog) {
      if (analyticsFailed || !configured) clearActor()
      return
    }
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

// The homepage and the docs pages are instrumented; everything else is not.
function tracked(pathname: string) {
  return pathname === '/' || pathname === '/docs' || pathname.startsWith('/docs/')
}

const attributionProperties = ['$referrer', '$referring_domain', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']
  .flatMap(key => [key, `$initial_${key.replace(/^\$/, '')}`])
const exceptionKeys = ['$exception_list', '$exception_level', '$exception_type', '$exception_message']
const events = new Set(['$pageview', '$pageleave', '$web_vitals', '$exception', 'conversion_requested', 'skill_install_command_copied'])
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
  ...exceptionKeys, ...attributionProperties,
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

// A referrer is reduced to its origin and a referring domain to its host;
// PostHog's '$direct' marker passes as it is.
function referrerOrigin(value: string) {
  if (value === '$direct') return value
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) ? url.origin : undefined
  } catch { return undefined }
}

function referringDomain(value: string) {
  if (value === '$direct') return value
  if (/^[a-z0-9.-]+(:\d+)?$/i.test(value)) return value
  return referrerOrigin(value)?.replace(/^https?:\/\//, '')
}

function sanitizeAttribution(eventProperties: Record<string, unknown>) {
  for (const key of attributionProperties) {
    const value = eventProperties[key]
    if (value === undefined) continue
    const kept = typeof value !== 'string' ? undefined
      : key.endsWith('referrer') ? referrerOrigin(value)
      : key.endsWith('referring_domain') ? referringDomain(value)
      : value
    if (kept === undefined) delete eventProperties[key]
    else eventProperties[key] = kept
  }
}

const exceptionFrameProperties = new Set(['platform', 'filename', 'abs_path', 'function', 'module', 'lineno', 'colno', 'in_app'])
const exceptionMechanismProperties = new Set(['type', 'handled', 'synthetic'])

// Error text and stack frames can carry page URLs, absolute or relative; keep
// what comes before a query or fragment. Any `?` or `#` attached to the text in
// front of it is cut through to the next space or quote, so parentheses inside a
// URL and relative paths can't carry one past a URL-shaped pattern.
function stripUrlQueries(text: string) {
  return text.replace(/([^\s'"`<])[?#][^\s'"`<>]*/g, '$1')
}

function scalarsFrom(value: unknown, allowed: Set<string>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(Object.entries(value)
    .filter(([property, content]) => allowed.has(property) && ['string', 'number', 'boolean'].includes(typeof content))
    .map(([property, content]) => [property, typeof content === 'string' ? stripUrlQueries(content) : content]))
}

function sanitizeException(eventProperties: Record<string, unknown>) {
  for (const key of ['$exception_level', '$exception_type', '$exception_message']) {
    const value = eventProperties[key]
    if (typeof value === 'string') eventProperties[key] = stripUrlQueries(value)
    else delete eventProperties[key]
  }
  const list = eventProperties.$exception_list
  if (!Array.isArray(list)) { delete eventProperties.$exception_list; return }
  eventProperties.$exception_list = list.filter(entry => entry && typeof entry === 'object').map(entry => {
    const sanitized: Record<string, unknown> = {}
    if (typeof entry.type === 'string') sanitized.type = stripUrlQueries(entry.type)
    if (typeof entry.value === 'string') sanitized.value = stripUrlQueries(entry.value)
    const mechanism = scalarsFrom(entry.mechanism, exceptionMechanismProperties)
    if (mechanism) sanitized.mechanism = mechanism
    const frames = entry.stacktrace?.frames
    if (Array.isArray(frames)) {
      sanitized.stacktrace = {
        ...(entry.stacktrace.type === 'raw' && { type: 'raw' }),
        frames: frames.map(frame => scalarsFrom(frame, exceptionFrameProperties)).filter(Boolean),
      }
    }
    return sanitized
  })
}

const configured = !blocked && import.meta.env.PROD && import.meta.env.VERCEL_ENV === 'production'
  && posthogKey && posthogHost?.startsWith('https://') && tracked(window.location.pathname)
if (!configured) {
  try { clearActor() } catch { /* Cookies may be blocked. */ }
}

function analyticsFailure() {
  enabled = false
  analyticsFailed = true
  posthog = undefined
  pendingEvents.length = 0
  try { clearActor() } catch { /* Cookies may be blocked. */ }
}

// Download and evaluate the SDK after controls are available, and only when
// production configuration and the visitor's privacy settings permit it.
export const analyticsReady: Promise<void> = configured ? import('posthog-js').then(({ default: sdk }) => {
  try {
    if (privacyBlocked() || !tracked(window.location.pathname)) { clearActor(); return }
    posthog = sdk
    sdk.init(posthogKey, {
      api_host: posthogHost,
      loaded: () => bridgeActor(),
      ui_host: 'https://eu.posthog.com',
      defaults: '2026-05-30',
      persistence: 'localStorage',
      person_profiles: 'never',
      // Keep scroll-depth collection active without capturing clicks, forms, or DOM content.
      autocapture: { dom_event_allowlist: [] },
      // The docs pages navigate with Astro's client router, so count path changes too.
      capture_pageview: 'history_change',
      capture_pageleave: true,
      capture_exceptions: true,
      capture_performance: { web_vitals: true, web_vitals_attribution: false },
      disable_session_recording: true,
      disable_surveys: true,
      enable_heatmaps: false,
      before_send(event) {
        try {
          if (privacyBlocked()) { clearActor(); return null }
        } catch { return null }
        const pathname = window.location.pathname
        if (!event || !events.has(event.event) || !tracked(pathname)) return null
        // Keep session/browser metrics, referrer origins and UTM tags, not
        // SDK-enriched URLs, other query parameters or user data.
        event.properties = Object.fromEntries(Object.entries(event.properties).filter(([key]) => properties.has(key)))
        sanitizeAttribution(event.properties)
        if (event.event === '$web_vitals') sanitizeWebVitalEvents(event.properties)
        if (event.event === '$exception') sanitizeException(event.properties)
        else for (const key of exceptionKeys) delete event.properties[key]
        Object.assign(event.properties, {
          $current_url: `${window.location.origin}${pathname}`,
          $host: window.location.host,
          $pathname: pathname,
          $process_person_profile: false,
          $geoip_disable: true,
          $ip: null,
          route: pathname === '/' ? 'landing' : 'docs',
          environment: 'production',
        })
        delete event.$set
        delete event.$set_once
        return event
      },
    })
    enabled = true
    for (const event of pendingEvents.splice(0)) captureLandingEvent(event)
  } catch {
    // Optional analytics must not stop the page from loading.
    analyticsFailure()
  }
}).catch(analyticsFailure) : Promise.resolve()

export function captureLandingEvent(event: LandingEvent) {
  if (!configured || window.location.pathname !== '/' || !events.has(event)) return
  try {
    if (privacyBlocked()) { clearActor(); return }
    if (event === 'conversion_requested') bridgeActor()
    if (!enabled || !posthog) {
      if (!analyticsFailed && pendingEvents.length < 20) pendingEvents.push(event)
      return
    }
    posthog.capture(event)
  } catch { /* Keep the interaction working if analytics fails. */ }
}
