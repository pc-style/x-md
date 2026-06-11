import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const upsertCustomerMapping = mutation({
  args: {
    userId: v.string(),
    autumnCustomerId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    planId: v.optional(v.string()),
    status: v.optional(v.string()),
    raw: v.optional(v.any()),
    serverSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireServerSecret(args.serverSecret)
    const existing = await ctx.db
      .query('billingCustomers')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .unique()
    const now = Date.now()
    const value = {
      userId: args.userId,
      autumnCustomerId: args.autumnCustomerId,
      stripeCustomerId: args.stripeCustomerId,
      planId: args.planId,
      status: args.status,
      raw: args.raw,
      updatedAt: now,
    }
    if (existing) {
      await ctx.db.patch(existing._id, value)
      return existing._id
    }
    return await ctx.db.insert('billingCustomers', { ...value, createdAt: now })
  },
})

export const getByUser = query({
  args: { userId: v.string(), serverSecret: v.optional(v.string()) },
  handler: async (ctx, { userId, serverSecret }) => {
    requireServerSecret(serverSecret)
    return await ctx.db
      .query('billingCustomers')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
  },
})

function requireServerSecret(serverSecret: string | undefined) {
  if (!process.env.CONVEX_SERVER_SECRET || serverSecret !== process.env.CONVEX_SERVER_SECRET) {
    throw new Error('Unauthorized')
  }
}
