import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { isEmail, normalizeEmail } from "./model"
import { cleanName, ensureContact, joinNetwork } from "./network"

/**
 * One-time move of the v2 single-owner setup into the network. Run from the dashboard after the
 * deploy: `migrations:migrateToNetwork {}` (optionally `{ "ownerName": "..." }`).
 * - the owner is the account of env OWNER_EMAIL (it must have signed in once);
 * - every active person sender becomes a member and a contact of the owner;
 * - open v2 invite links move to the owner as inviter (their waiting sender stays until claimed).
 * Agent keys are left alone: /mcp keeps them working. Safe to run again: a second run changes nothing.
 */
export const migrateToNetwork = internalMutation({
  args: { ownerName: v.optional(v.string()) },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      ownerId: v.id("users"),
      members: v.number(),
      contacts: v.number(),
      invites: v.number(),
    }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("no-owner-email"), v.literal("owner-not-signed-in")) }),
  ),
  handler: async (ctx, args) => {
    const email = normalizeEmail(process.env.OWNER_EMAIL ?? "")
    if (!isEmail(email)) return { ok: false as const, error: "no-owner-email" as const }
    const owner = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .first()
    if (!owner) return { ok: false as const, error: "owner-not-signed-in" as const }
    const now = Date.now()

    let members = 0
    if (owner.memberAt === undefined) members++
    await joinNetwork(ctx, owner, null, cleanName(args.ownerName), now)

    let contacts = 0
    const senders = await ctx.db.query("senders").take(1000)
    for (const s of senders) {
      if (s.kind !== "person" || s.status !== "active" || !s.userId || s.userId === owner._id) continue
      const user = await ctx.db.get(s.userId)
      if (!user) continue
      if (user.memberAt === undefined) members++
      await joinNetwork(ctx, user, null, s.name, now)
      if (user.invitedBy === undefined) await ctx.db.patch(user._id, { invitedBy: owner._id })
      if (await ensureContact(ctx, owner._id, user._id, now)) contacts++
    }

    let invites = 0
    const links = await ctx.db
      .query("inviteLinks")
      .withIndex("by_expiresAt", (q) => q.gt("expiresAt", now))
      .take(1000)
    for (const link of links) {
      if (link.inviterId || !link.senderId || link.claimedAt !== undefined) continue
      const sender = await ctx.db.get(link.senderId)
      if (!sender || sender.kind !== "person" || sender.status !== "invited") continue
      await ctx.db.patch(link._id, { inviterId: owner._id, name: sender.name, createdAt: link.createdAt ?? link._creationTime })
      invites++
    }

    return { ok: true as const, ownerId: owner._id, members, contacts, invites }
  },
})
