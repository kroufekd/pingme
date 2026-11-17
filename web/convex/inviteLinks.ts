import { getAuthUserId } from "@convex-dev/auth/server"
import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import { activeSenderForUser, isEmail, normalizeEmail, sha256Hex } from "./model"

/** The link behind `token` while it can still be used: not claimed, not expired, sender still invited. */
async function openLink(ctx: QueryCtx, token: string, now: number) {
  if (!token || token.length > 200) return null
  const tokenHash = sha256Hex(token)
  const link = await ctx.db
    .query("inviteLinks")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .first()
  if (!link || link.claimedAt !== undefined || link.expiresAt <= now) return null
  const sender = await ctx.db.get(link.senderId)
  if (!sender || sender.kind !== "person" || sender.status !== "invited") return null
  return { link, sender }
}

/** Whether an invite link still works. Says nothing else. */
export const check = query({
  args: { token: v.string() },
  returns: v.union(v.object({ ok: v.literal(true), name: v.string() }), v.object({ ok: v.literal(false) })),
  handler: async (ctx, { token }) => {
    const open = await openLink(ctx, token, Date.now())
    return open ? { ok: true as const, name: open.sender.name } : { ok: false as const }
  },
})

/** Ties an email to the link and lets the code be sent to it. The web then signs in with that email. */
export const start = mutation({
  args: { token: v.string(), email: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("bad-link"), v.literal("bad-email")) }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now()
    const open = await openLink(ctx, args.token, now)
    if (!open) return { ok: false as const, error: "bad-link" as const }
    const email = normalizeEmail(args.email)
    if (!isEmail(email)) return { ok: false as const, error: "bad-email" as const }
    await ctx.db.patch(open.link._id, { email })
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first()
    if (!invite) await ctx.db.insert("invites", { email, name: open.sender.name, createdAt: now })
    return { ok: true as const }
  },
})

/** After the code: makes the signed-in person the sender the link was made for. */
export const claim = mutation({
  args: { token: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), name: v.string() }),
    v.object({
      ok: v.literal(false),
      error: v.union(v.literal("bad-link"), v.literal("wrong-email"), v.literal("signed-out")),
    }),
  ),
  handler: async (ctx, { token }) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { ok: false as const, error: "signed-out" as const }
    const now = Date.now()
    const open = await openLink(ctx, token, now)
    if (!open) return { ok: false as const, error: "bad-link" as const }
    const user = await ctx.db.get(userId)
    const email = user?.email ? normalizeEmail(user.email) : ""
    if (!email || !open.link.email || email !== open.link.email) {
      return { ok: false as const, error: "wrong-email" as const }
    }
    await ctx.db.patch(open.link._id, { claimedAt: now })
    const existing = await activeSenderForUser(ctx, userId)
    if (existing) {
      // Already in under another sender: keep that one, drop the new one.
      await ctx.db.delete(open.sender._id)
      return { ok: true as const, name: existing.name }
    }
    await ctx.db.patch(open.sender._id, { userId, email, status: "active" })
    return { ok: true as const, name: open.sender.name }
  },
})
