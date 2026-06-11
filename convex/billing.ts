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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('billingCustomers')
      .withIndex('by_userId', (q) => q.eq('userId', args.userId))
      .unique()
    const now = Date.now()
    const value = { ...args, updatedAt: now }
    if (existing) {
      await ctx.db.patch(existing._id, value)
      return existing._id
    }
    return await ctx.db.insert('billingCustomers', { ...args, createdAt: now, updatedAt: now })
  },
})

export const getByUser = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query('billingCustomers')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
  },
})
