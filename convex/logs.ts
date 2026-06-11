import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const logRequest = mutation({
  args: {
    userId: v.optional(v.string()),
    authMethod: v.union(v.literal('anonymous'), v.literal('clerk'), v.literal('api_key')),
    route: v.string(),
    status: v.number(),
    featureId: v.optional(v.string()),
    credits: v.optional(v.number()),
    source: v.optional(v.string()),
    cache: v.optional(v.string()),
    serverSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireServerSecret(args.serverSecret)
    return await ctx.db.insert('requestLogs', {
      userId: args.userId,
      authMethod: args.authMethod,
      route: args.route,
      status: args.status,
      featureId: args.featureId,
      credits: args.credits,
      source: args.source,
      cache: args.cache,
      createdAt: Date.now(),
    })
  },
})

export const recordFeatureRun = mutation({
  args: {
    userId: v.string(),
    featureId: v.string(),
    credits: v.number(),
    status: v.union(v.literal('allowed'), v.literal('denied'), v.literal('failed'), v.literal('completed')),
    autumnCustomerId: v.string(),
    autumnCheck: v.optional(v.any()),
    input: v.optional(v.any()),
    outputSummary: v.optional(v.any()),
    serverSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireServerSecret(args.serverSecret)
    return await ctx.db.insert('featureRuns', {
      userId: args.userId,
      featureId: args.featureId,
      credits: args.credits,
      status: args.status,
      autumnCustomerId: args.autumnCustomerId,
      autumnCheck: args.autumnCheck,
      input: args.input,
      outputSummary: args.outputSummary,
      createdAt: Date.now(),
    })
  },
})

export const recentRequests = query({
  args: { userId: v.string(), limit: v.optional(v.number()), serverSecret: v.optional(v.string()) },
  handler: async (ctx, { userId, limit, serverSecret }) => {
    requireServerSecret(serverSecret)
    return await ctx.db
      .query('requestLogs')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .order('desc')
      .take(limit ?? 50)
  },
})

function requireServerSecret(serverSecret: string | undefined) {
  if (!process.env.CONVEX_SERVER_SECRET || serverSecret !== process.env.CONVEX_SERVER_SECRET) {
    throw new Error('Unauthorized')
  }
}
