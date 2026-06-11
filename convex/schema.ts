import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  users: defineTable({
    clerkUserId: v.string(),
    autumnCustomerId: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_clerkUserId', ['clerkUserId'])
    .index('by_autumnCustomerId', ['autumnCustomerId']),

  apiKeys: defineTable({
    userId: v.string(),
    keyHash: v.string(),
    tokenPreview: v.string(),
    label: v.optional(v.string()),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index('by_userId', ['userId'])
    .index('by_keyHash', ['keyHash']),

  requestLogs: defineTable({
    userId: v.optional(v.string()),
    authMethod: v.union(v.literal('anonymous'), v.literal('clerk'), v.literal('api_key')),
    route: v.string(),
    status: v.number(),
    featureId: v.optional(v.string()),
    credits: v.optional(v.number()),
    source: v.optional(v.string()),
    cache: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_userId', ['userId'])
    .index('by_createdAt', ['createdAt']),

  featureRuns: defineTable({
    userId: v.string(),
    featureId: v.string(),
    credits: v.number(),
    status: v.union(v.literal('allowed'), v.literal('denied'), v.literal('failed'), v.literal('completed')),
    autumnCustomerId: v.string(),
    autumnCheck: v.optional(v.any()),
    input: v.optional(v.any()),
    outputSummary: v.optional(v.any()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index('by_userId_createdAt', ['userId', 'createdAt'])
    .index('by_featureId_createdAt', ['featureId', 'createdAt']),

  billingCustomers: defineTable({
    userId: v.string(),
    autumnCustomerId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    planId: v.optional(v.string()),
    status: v.optional(v.string()),
    raw: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_userId', ['userId'])
    .index('by_autumnCustomerId', ['autumnCustomerId']),
})
