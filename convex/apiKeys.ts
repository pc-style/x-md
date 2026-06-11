import { mutation, query } from './_generated/server'
import { v } from 'convex/values'

export const create = mutation({
  args: {
    userId: v.string(),
    keyHash: v.string(),
    tokenPreview: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('apiKeys', {
      ...args,
      createdAt: Date.now(),
    })
  },
})

export const revoke = mutation({
  args: { userId: v.string(), keyHash: v.string() },
  handler: async (ctx, { userId, keyHash }) => {
    const record = await ctx.db
      .query('apiKeys')
      .withIndex('by_keyHash', (q) => q.eq('keyHash', keyHash))
      .unique()
    if (!record || record.userId !== userId) return false
    await ctx.db.patch(record._id, { revokedAt: Date.now() })
    return true
  },
})

export const listForUser = query({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query('apiKeys')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .collect()
  },
})

export const getActiveByHash = query({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) => {
    const record = await ctx.db
      .query('apiKeys')
      .withIndex('by_keyHash', (q) => q.eq('keyHash', keyHash))
      .unique()
    if (!record || record.revokedAt) return null
    return record
  },
})
