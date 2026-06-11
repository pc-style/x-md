import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const upsertFromClerk = mutation({
  args: {
    clerkUserId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    serverSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireServerSecret(args.serverSecret)
    const now = Date.now()
    const existing = await ctx.db
      .query('users')
      .withIndex('by_clerkUserId', (q) => q.eq('clerkUserId', args.clerkUserId))
      .unique()

    const patch: { email?: string; name?: string; updatedAt: number } = { updatedAt: now }
    if (args.email !== undefined) patch.email = args.email
    if (args.name !== undefined) patch.name = args.name

    if (existing) {
      await ctx.db.patch(existing._id, patch)
      return existing._id
    }

    return await ctx.db.insert('users', {
      clerkUserId: args.clerkUserId,
      autumnCustomerId: args.clerkUserId,
      email: args.email,
      name: args.name,
      createdAt: now,
      updatedAt: now,
    })
  },
})

export const current = query({
  args: { clerkUserId: v.string(), serverSecret: v.optional(v.string()) },
  handler: async (ctx, { clerkUserId, serverSecret }) => {
    requireServerSecret(serverSecret)
    return await ctx.db
      .query('users')
      .withIndex('by_clerkUserId', (q) => q.eq('clerkUserId', clerkUserId))
      .unique()
  },
})

function requireServerSecret(serverSecret: string | undefined) {
  if (!process.env.CONVEX_SERVER_SECRET || serverSecret !== process.env.CONVEX_SERVER_SECRET) {
    throw new Error('Unauthorized')
  }
}
