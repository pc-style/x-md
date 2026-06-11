import { createClerkClient, verifyToken } from '@clerk/backend'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '../convex/_generated/api.js'
import { extractBearerToken, hashApiKey } from './monetization.js'

export type AuthContext = {
  userId: string | null
  authMethod: 'anonymous' | 'clerk' | 'api_key'
  email?: string | null
  name?: string | null
}

type HeaderBag = Record<string, string | string[] | undefined>

export function getConvexClient(): ConvexHttpClient | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? process.env.CONVEX_URL
  if (!url) return null
  return new ConvexHttpClient(url)
}

export async function resolveAuthContext(headers: HeaderBag): Promise<AuthContext> {
  const authorization = headers.authorization ?? headers.Authorization
  const token = extractBearerToken(authorization)

  if (token?.startsWith('xmd_')) {
    const owner = await resolveApiKeyUser(token)
    if (owner) return { userId: owner, authMethod: 'api_key' }
  }

  if (token) {
    const clerkUser = await resolveClerkToken(token)
    if (clerkUser) return { ...clerkUser, authMethod: 'clerk' }
  }

  return { userId: null, authMethod: 'anonymous' }
}

async function resolveApiKeyUser(apiKey: string): Promise<string | null> {
  const client = getConvexClient()
  if (!client) return null
  const record = await client.query(api.apiKeys.getActiveByHash, {
    keyHash: hashApiKey(apiKey),
    serverSecret: process.env.CONVEX_SERVER_SECRET,
  })
  return record?.userId ?? null
}

async function resolveClerkToken(token: string): Promise<Omit<AuthContext, 'authMethod'> | null> {
  const secretKey = process.env.CLERK_SECRET_KEY
  if (!secretKey) return null

  try {
    const payload = await verifyToken(token, { secretKey })
    const userId = payload.sub
    const clerk = createClerkClient({ secretKey })
    if (!userId) return null

    const user = await clerk.users.getUser(userId)
    const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null
    const name = user.fullName ?? user.username ?? null
    return { userId, email, name }
  } catch {
    return null
  }
}

export async function syncUserToBackends(auth: AuthContext): Promise<void> {
  if (!auth.userId || auth.authMethod !== 'clerk') return

  const convex = getConvexClient()
  if (convex) {
    await convex.mutation(api.users.upsertFromClerk, {
      clerkUserId: auth.userId,
      email: auth.email ?? undefined,
      name: auth.name ?? undefined,
      serverSecret: process.env.CONVEX_SERVER_SECRET,
    })
  }
}

export async function logRequest(args: {
  auth: AuthContext
  route: string
  status: number
  featureId?: string
  credits?: number
  source?: string
  cache?: string
}): Promise<void> {
  const convex = getConvexClient()
  if (!convex) return
  try {
    await convex.mutation(api.logs.logRequest, {
      userId: args.auth.userId ?? undefined,
      authMethod: args.auth.authMethod,
      route: args.route,
      status: args.status,
      featureId: args.featureId,
      credits: args.credits,
      source: args.source,
      cache: args.cache,
      serverSecret: process.env.CONVEX_SERVER_SECRET,
    })
  } catch (error) {
    console.error('Failed to log request', error)
  }
}

export async function recordFeatureRun(args: {
  userId: string
  featureId: string
  credits: number
  status: 'allowed' | 'denied' | 'failed' | 'completed'
  autumnCustomerId: string
  autumnCheck?: unknown
  input?: unknown
  outputSummary?: unknown
}): Promise<void> {
  const convex = getConvexClient()
  if (!convex) return
  try {
    await convex.mutation(api.logs.recordFeatureRun, {
      userId: args.userId,
      featureId: args.featureId,
      credits: args.credits,
      status: args.status,
      autumnCustomerId: args.autumnCustomerId,
      autumnCheck: args.autumnCheck,
      input: args.input,
      outputSummary: args.outputSummary,
      serverSecret: process.env.CONVEX_SERVER_SECRET,
    })
  } catch (error) {
    console.error('Failed to record feature run', error)
  }
}
