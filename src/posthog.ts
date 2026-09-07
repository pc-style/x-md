const posthogKey = import.meta.env.VITE_POSTHOG_KEY
const posthogHost = import.meta.env.VITE_POSTHOG_HOST

/** Manual action counts only. No SDK, persistent identity, URL, or DOM capture. */
export function captureLandingEvent(event: 'conversion_requested' | 'skill_install_command_copied') {
  if (!import.meta.env.PROD || import.meta.env.VERCEL_ENV !== 'production' || !posthogKey || !posthogHost?.startsWith('https://') || window.location.pathname !== '/') return
  if (event !== 'conversion_requested' && event !== 'skill_install_command_copied') return

  try {
    const uuid = crypto.randomUUID()
    void fetch(`${posthogHost.replace(/\/$/, '')}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      keepalive: true,
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        api_key: posthogKey,
        event,
        uuid,
        distinct_id: `anonymous:${uuid}`,
        properties: {
          route: 'landing',
          environment: 'production',
          $process_person_profile: false,
          $geoip_disable: true,
          $ip: null,
        },
      }),
    }).catch(() => {})
  } catch {
    // Analytics must not interrupt opening a conversion or copying a command.
  }
}
