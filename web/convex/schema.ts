import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { authTables } from "@convex-dev/auth/server"
import { commandKind, deviceKind, envelope, recipient, repeat, senderKind, snapTask, taskState, urgency } from "./validators"

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
    // Member of the network since (claimed an invite, or migrated). Unset = not a member.
    memberAt: v.optional(v.number()),
    // Who invited this person first. Shown in the intro.
    invitedBy: v.optional(v.id("users")),
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
  // Legacy links (owner's Mac over MAC_TOKEN) have senderId; network links have inviterId and name.
  inviteLinks: defineTable({
    tokenHash: v.string(),
    senderId: v.optional(v.id("senders")),
    inviterId: v.optional(v.id("users")),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    createdAt: v.optional(v.number()),
    expiresAt: v.number(),
    claimedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_senderId", ["senderId"])
    .index("by_inviterId", ["inviterId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Short-lived state of one sent task for its sender. Never holds the task text.
  // Legacy rows have senderId (and a plaintext reply); network rows have fromUserId/toUserId and
  // only ciphertext: titleEnvelopes and replyEnvelopes, one per device of the sender.
  taskStatus: defineTable({
    senderId: v.optional(v.id("senders")),
    fromUserId: v.optional(v.id("users")),
    toUserId: v.optional(v.id("users")),
    taskRef: v.string(),
    status: taskState,
    at: v.number(),
    snoozedUntil: v.optional(v.number()),
    reply: v.optional(v.string()),
    replyAt: v.optional(v.number()),
    typingUntil: v.optional(v.number()),
    expiresAt: v.number(),
    fromAgent: v.optional(v.string()),
    forAgent: v.optional(v.boolean()),
    urgency: v.optional(urgency),
    dueAt: v.optional(v.number()),
    repeat: v.optional(repeat),
    createdAt: v.optional(v.number()),
    titleEnvelopes: v.optional(v.array(envelope)),
    replyEnvelopes: v.optional(v.array(envelope)),
    // Legacy remote MCP message to the owner: plaintext, reply in `reply`.
    unencrypted: v.optional(v.literal(true)),
  })
    .index("by_taskRef", ["taskRef"])
    .index("by_senderId", ["senderId"])
    .index("by_fromUserId", ["fromUserId"])
    .index("by_expiresAt", ["expiresAt"]),

  // ---- Network (phase 2) ----

  // A Mac app (token auth, only the SHA-256 of the token is stored) or a browser (Convex Auth).
  // publicKey is raw X25519, standard base64. A revoked device can do nothing.
  devices: defineTable({
    userId: v.id("users"),
    kind: deviceKind,
    publicKey: v.string(),
    tokenHash: v.optional(v.string()),
    name: v.string(),
    createdAt: v.number(),
    lastSeen: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_userId", ["userId"])
    .index("by_tokenHash", ["tokenHash"]),

  // Two members who know each other, both directions in one row (a < b as strings).
  contacts: defineTable({
    a: v.id("users"),
    b: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_a", ["a", "b"])
    .index("by_b", ["b", "a"]),

  // Pings on their way to the recipient's Macs: one envelope per active Mac of the recipient.
  // Deleted when every target device confirmed it, or at expiresAt.
  messages: defineTable({
    ref: v.string(),
    fromUserId: v.optional(v.id("users")),
    // Legacy remote MCP only: the agent key and its name.
    fromSenderId: v.optional(v.id("senders")),
    fromName: v.optional(v.string()),
    fromAgent: v.optional(v.string()),
    toUserId: v.id("users"),
    forAgent: v.boolean(),
    urgency,
    dueAt: v.number(),
    repeat: v.optional(repeat),
    createdAt: v.number(),
    expiresAt: v.number(),
    envelopes: v.array(envelope),
    deliveredTo: v.array(v.id("devices")),
    // Legacy remote MCP only: plaintext, flagged. Never set for network messages.
    text: v.optional(v.string()),
    unencrypted: v.optional(v.literal(true)),
  })
    .index("by_ref", ["ref"])
    .index("by_toUserId", ["toUserId"])
    .index("by_expiresAt", ["expiresAt"]),

  // A Mac asking to join an account. The browser approves it with the hash of the secret
  // from the URL fragment and the code shown on that Mac; the Mac claims it with the secret.
  pairRequests: defineTable({
    pairId: v.string(),
    secretHash: v.string(),
    publicKey: v.string(),
    name: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    userId: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    // Wrong pairing codes typed on /pair; at CODE_TRIES the request is deleted.
    codeMisses: v.optional(v.number()),
    // Set by the first claim: the new device and its token sealed to publicKey. Later claims
    // get the same blob until expiresAt, so whoever else polls first gains nothing.
    deviceId: v.optional(v.id("devices")),
    sealedToken: v.optional(v.object({ enc: v.string(), ct: v.string() })),
  })
    .index("by_pairId", ["pairId"])
    .index("by_expiresAt", ["expiresAt"]),

  // Fixed windows: pairing starts (key "pairGuard"), sends per pair of users, invite links.
  rateLimits: defineTable({
    key: v.string(),
    count: v.number(),
    windowStart: v.number(),
    expiresAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expiresAt", ["expiresAt"]),
})
