import { FX_BASES } from './fxtwitter.js'

/**
 * Import capacity as the upstream pool reports it. Every configured base is
 * asked for `/xmd/health` (the account snapshot a self-hosted FxEmbed exposes);
 * bases without it, such as the public instance, are listed as `external`.
 */
export interface UpstreamHealth {
  base: string
  kind: 'self-hosted' | 'external'
  total?: number
  ready?: number
  resting?: number
  retired?: number
  unknown?: number
  remainingKnown?: number
  accounts?: unknown[]
  error?: string
}

export async function upstreamHealth(): Promise<UpstreamHealth[]> {
  return Promise.all(FX_BASES.map(async (base): Promise<UpstreamHealth> => {
    try {
      const response = await fetch(`${base}/xmd/health`, { headers: { 'User-Agent': 'x-md-admin/1.0' }, signal: AbortSignal.timeout(4000) })
      if (response.status === 404) return { base, kind: 'external' }
      if (!response.ok) return { base, kind: 'self-hosted', error: `HTTP ${response.status}` }
      const body = (await response.json()) as Omit<UpstreamHealth, 'base' | 'kind'>
      return { base, kind: 'self-hosted', ...body }
    } catch (error) {
      return { base, kind: 'self-hosted', error: String(error).slice(0, 120) }
    }
  }))
}

