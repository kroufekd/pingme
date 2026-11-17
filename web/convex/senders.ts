import { v } from "convex/values"
import type { Infer } from "convex/values"
import { getAuthUserId } from "@convex-dev/auth/server"
import { internalMutation, internalQuery, mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { activeSenderForUser, normalizeEmail } from "./model"
import { cleanName, nameOf, networkMember, removeMember } from "./network"
import { senderKind } from "./validators"

/**
 * Who the web is talking to. A member joined the network (or is still an active v2 sender).
 * `userId` is what the web puts in the AAD; `senderId` exists only for v2 senders.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.object({ status: v.literal("signedOut") }),
    v.object({ status: v.literal("notMember"), email: v.string() }),
    v.object({
      status: v.literal("member"),
      name: v.string(),
      userId: v.string(),
      senderId: v.optional(v.string()),
      onboarded: v.boolean(),
      inviterName: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { status: "signedOut" as const }
    const user = await ctx.db.get(userId)
    const email = user?.email ? normalizeEmail(user.email) : ""
    const sender = await activeSenderForUser(ctx, userId)
    if (!user || (user.memberAt === undefined && !sender)) return { status: "notMember" as const, email }
    const inviter = user.invitedBy ? await ctx.db.get(user.invitedBy) : null
    return {
      status: "member" as const,
      name: cleanName(user.name) || sender?.name || nameOf(user),
      userId: userId as string,
      ...(sender ? { senderId: sender._id as string } : {}),
      onboarded: user.onboardedAt !== undefined,
      ...(inviter ? { inviterName: nameOf(inviter) } : {}),
    }
  },
})

/** The intro was seen. Only members, only once. */
export const finishOnboarding = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const m = await networkMember(ctx)
    if (m && m.user.onboardedAt === undefined) await ctx.db.patch(m.userId, { onboardedAt: Date.now() })
    return null
  },
})

// ---- Owner only (Mac over MAC_TOKEN, called from http.ts) ----

/** A new person, waiting to open the link. */
export const createInvite = internalMutation({
  args: { name: v.string(), tokenHash: v.string(), now: v.number(), expiresAt: v.number() },
  returns: v.id("senders"),
  handler: async (ctx, { name, tokenHash, now, expiresAt }) => {
    const senderId = await ctx.db.insert("senders", {
      kind: "person",
      name,
      status: "invited",
      createdAt: now,
    })
    await ctx.db.insert("inviteLinks", { tokenHash, senderId, expiresAt })
    return senderId
  },
})

/** A new agent. The Mac made the key and sends only its hash. */
export const createAgent = internalMutation({
  args: { name: v.string(), keyHash: v.string(), keyTail: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), senderId: v.id("senders") }),
    v.object({ ok: v.literal(false), error: v.literal("duplicate") }),
  ),
  handler: async (ctx, { name, keyHash, keyTail }) => {
    const existing = await ctx.db
      .query("senders")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
      .first()
    if (existing) return { ok: false as const, error: "duplicate" as const }
    const senderId = await ctx.db.insert("senders", {
      kind: "agent",
      name,
      keyHash,
      keyTail,
      status: "active",
      createdAt: Date.now(),
    })
    return { ok: true as const, senderId }
  },
})

const listedSender = v.object({
  id: v.string(),
  kind: senderKind,
  name: v.string(),
  status: v.union(v.literal("invited"), v.literal("active")),
  email: v.optional(v.string()),
  keyTail: v.optional(v.string()),
  inviteExpiresAt: v.optional(v.number()),
  lastUsedAt: v.optional(v.number()),
  createdAt: v.number(),
})

/** People, open invitations and agents for the owner. Revoked ones are left out. */
export const list = internalQuery({
  args: {},
  returns: v.array(listedSender),
  handler: async (ctx) => {
    const rows = await ctx.db.query("senders").order("desc").take(500)
    const out: Infer<typeof listedSender>[] = []
    for (const s of rows) {
      if (s.status === "revoked") continue
      let inviteExpiresAt: number | undefined
      if (s.status === "invited") {
        const links = await ctx.db
          .query("inviteLinks")
          .withIndex("by_senderId", (q) => q.eq("senderId", s._id))
          .take(10)
        const open = links.filter((l) => l.claimedAt === undefined).map((l) => l.expiresAt)
        if (open.length) inviteExpiresAt = Math.max(...open)
      }
      out.push({
        id: s._id as string,
        kind: s.kind,
        name: s.name,
        status: s.status,
        email: s.email,
        keyTail: s.keyTail,
        inviteExpiresAt,
        lastUsedAt: s.lastUsedAt,
        createdAt: s.createdAt,
      })
    }
    return out
  },
})

/** Drops an email from the code allowlist unless another active person uses it. */
async function dropInvite(ctx: MutationCtx, email: string, keep: Id<"senders">) {
  const normalized = normalizeEmail(email)
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", normalized))
    .first()
  const other = user ? await activeSenderForUser(ctx, user._id) : null
  if (other && other._id !== keep) return
  const rows = await ctx.db
    .query("invites")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .take(10)
  for (const row of rows) await ctx.db.delete(row._id)
}

/**
 * Removes a person or an agent: no call gets through any more, and its queue,
 * statuses, links and code allowlist entry are deleted. A person also leaves the network:
 * membership, contacts, devices and its own invite links.
 */
export const revoke = internalMutation({
  args: { senderId: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("senders", args.senderId)
    const sender = id ? await ctx.db.get(id) : null
    if (!sender) return { ok: false }
    const userId = sender.userId
    await ctx.db.patch(sender._id, { status: "revoked", userId: undefined })
    if (userId && sender.kind === "person") await removeMember(ctx, userId, Date.now())

    const emails = new Set<string>()
    if (sender.email) emails.add(sender.email)
    const links = await ctx.db
      .query("inviteLinks")
      .withIndex("by_senderId", (q) => q.eq("senderId", sender._id))
      .take(100)
    for (const link of links) {
      if (link.email && link.claimedAt === undefined) emails.add(link.email)
      await ctx.db.delete(link._id)
    }
    for (const email of emails) await dropInvite(ctx, email, sender._id)

    const statuses = await ctx.db
      .query("taskStatus")
      .withIndex("by_senderId", (q) => q.eq("senderId", sender._id))
      .take(1000)
    for (const s of statuses) {
      await ctx.db.delete(s._id)
      // Legacy MCP pings already routed to the owner's paired Mac (network queue).
      const queued = await ctx.db
        .query("messages")
        .withIndex("by_ref", (q) => q.eq("ref", s.taskRef))
        .take(5)
      for (const m of queued) if (m.fromSenderId === sender._id) await ctx.db.delete(m._id)
    }
    const commands = await ctx.db
      .query("commands")
      .withIndex("by_senderId", (q) => q.eq("senderId", sender._id))
      .take(1000)
    for (const c of commands) await ctx.db.delete(c._id)
    return { ok: true }
  },
})

/**
 * One-time move of a v1 email invite (for example Viki) to an active person sender,
 * without an invite link. Needs the person to have signed in once (a users row).
 * Run from the dashboard: `senders:adoptInvite { email }`.
 */
export const adoptInvite = internalMutation({
  args: { email: v.string(), name: v.optional(v.string()) },
  returns: v.union(
    v.object({ ok: v.literal(true), senderId: v.id("senders") }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("no-invite"), v.literal("no-user")) }),
  ),
  handler: async (ctx, args) => {
    const email = normalizeEmail(args.email)
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first()
    if (!invite) return { ok: false as const, error: "no-invite" as const }
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first()
    if (!user) return { ok: false as const, error: "no-user" as const }
    const existing = await activeSenderForUser(ctx, user._id)
    if (existing) return { ok: true as const, senderId: existing._id }
    const senderId = await ctx.db.insert("senders", {
      kind: "person",
      name: (args.name ?? invite.name).trim().slice(0, 60) || "Host",
      userId: user._id,
      email,
      status: "active",
      createdAt: Date.now(),
    })
    return { ok: true as const, senderId }
  },
})
