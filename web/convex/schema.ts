import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"
import { commandKind, recipient, repeat, senderKind, snapTask, taskState, urgency } from "./validators"

// Macaly is only the line between the web and the Mac. Tasks live on the Mac.
export default defineSchema({
  ...authTables,
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // Saw the short intro once. Per account, so a new browser does not show it again.
    onboardedAt: v.optional(v.number()),
  }).index("email", ["email"]),

  // Only invited emails can sign in and use the app.
  invites: defineTable({
    email: v.string(),
    name: v.string(),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  // Messages from the web on their way to the Mac. Deleted once the Mac confirms it has them.
  commands: defineTable({
    kind: commandKind,
    taskId: v.optional(v.string()),
    title: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    followUpTitle: v.optional(v.string()),
    followUpMinutes: v.optional(v.number()),
    repeat: v.optional(repeat),
    byName: v.string(),
    createdAt: v.number(),
    senderId: v.optional(v.id("senders")),
    senderKind: v.optional(senderKind),
    urgency: v.optional(urgency),
    to: v.optional(recipient),
  }).index("by_senderId", ["senderId"]),

  // The Mac's current list, kept only while someone has the web open.
  snapshot: defineTable({
    at: v.number(),
    tasks: v.array(snapTask),
  }),

  // Who got in with the PIN. The browser keeps the token; only a name is stored with it.
  pinSessions: defineTable({
    token: v.string(),
    name: v.string(),
    createdAt: v.number(),
  }).index("by_token", ["token"]),

  // Wrong PIN tries, so four digits cannot be guessed quickly.
  pinGuard: defineTable({
    failures: v.number(),
    windowStart: v.number(),
    lockedUntil: v.number(),
  }),

  // Last time the Mac checked in and last time the web was open.
  heartbeats: defineTable({
    device: v.string(),
    lastSeen: v.number(),
  }).index("by_device", ["device"]),

  // Who may send tasks: people (email code, joined by invite link) and agents (key over MCP).
  // Membership is only an active row found by userId (person) or keyHash (agent).
  senders: defineTable({
    kind: senderKind,
    name: v.string(),
    userId: v.optional(v.id("users")),
    email: v.optional(v.string()),
    keyHash: v.optional(v.string()),
    keyTail: v.optional(v.string()),
    status: v.union(v.literal("invited"), v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    rateWindowStart: v.optional(v.number()),
    rateCount: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_keyHash", ["keyHash"]),

  // One link, one person. Only the hash of the token is stored.
  inviteLinks: defineTable({
    tokenHash: v.string(),
    senderId: v.id("senders"),
    email: v.optional(v.string()),
    expiresAt: v.number(),
    claimedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_senderId", ["senderId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Short-lived state of one sent task for its sender. Never holds the task text.
  taskStatus: defineTable({
    senderId: v.id("senders"),
    taskRef: v.string(),
    status: taskState,
    at: v.number(),
    snoozedUntil: v.optional(v.number()),
    reply: v.optional(v.string()),
    replyAt: v.optional(v.number()),
    typingUntil: v.optional(v.number()),
    expiresAt: v.number(),
  })
    .index("by_taskRef", ["taskRef"])
    .index("by_senderId", ["senderId"])
    .index("by_expiresAt", ["expiresAt"]),
})
