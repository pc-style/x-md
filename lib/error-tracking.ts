import { PostHog } from 'posthog-node'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { exceptionKeys, sanitizeException } from './exception-properties.js'

type VercelHandler<T> = (req: VercelRequest, res: VercelResponse) => T | Promise<T>

let posthog: PostHog | undefined
const properties = new Set([...exceptionKeys, '$lib', '$lib_version'])

/** Capture errors rejected past a Vercel handler, then preserve Vercel's error handling. */
export function withErrorTracking<T>(handler: VercelHandler<T>): VercelHandler<T> {
  return async (req, res) => {
    try {
      return await handler(req, res)
    } catch (error) {
      try {
        const token = process.env.POSTHOG_PROJECT_TOKEN || process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN
        const host = process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST
        if (process.env.VERCEL_ENV === 'production' && token && host?.startsWith('https://')) {
          posthog ??= new PostHog(token, {
            host, flushInterval: 0, requestTimeout: 3000, fetchRetryCount: 0, disableGeoip: true,
            before_send(event) {
              if (event.event !== '$exception') return null
              const kept = Object.fromEntries(Object.entries(event.properties ?? {}).filter(([key]) => properties.has(key)))
              sanitizeException(kept)
              return { ...event, distinctId: 'server', properties: {
                ...kept, environment: 'production', $process_person_profile: false, $geoip_disable: true, $ip: null,
              } }
            },
          })
          posthog.captureException(error, 'server')
          await posthog.flush()
        }
      } catch {
        console.warn('[analytics] PostHog exception delivery failed')
      }
      throw error
    }
  }
}
