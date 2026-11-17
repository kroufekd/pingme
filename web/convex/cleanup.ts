import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { DAY } from "./model"
import { dropAllowlistIfUnused } from "./network"

const BATCH = 500
const COMMAND_TTL = 60 * DAY

/**
 * Hourly: deletes expired task statuses, expired invite links (and the person they
 * invited, if that person never joined) and commands older than 60 days.
 * Every read is an index range with a bounded take; what is read is deleted, so a
 * later run never reads the same rows again.
 */
export const run = internalMutation({
  args: {},
  returns: v.object({ taskStatus: v.number(), inviteLinks: v.number(), senders: v.number(), commands: v.number() }),
  handler: async (ctx) => {
    const now = Date.now()

    const statuses = await ctx.db
      .query("taskStatus")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH)
    for (const s of statuses) await ctx.db.delete(s._id)

    // Expired links are useless whether claimed or not, so all of them go (claimed ones
    // left in this index range would be read again every hour).
    const links = await ctx.db
      .query("inviteLinks")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH)
    let senders = 0
    for (const link of links) {
      await ctx.db.delete(link._id)
      if (link.claimedAt !== undefined) continue
      // A network link that nobody used: its email no longer needs a code.
      if (link.email && link.inviterId) await dropAllowlistIfUnused(ctx, link.email)
      if (!link.senderId) continue
      const sender = await ctx.db.get(link.senderId)
      if (!sender || sender.status !== "invited") continue
      const others = await ctx.db
        .query("inviteLinks")
        .withIndex("by_senderId", (q) => q.eq("senderId", sender._id))
        .take(10)
      if (others.some((o) => o._id !== link._id && o.expiresAt >= now)) continue
      await ctx.db.delete(sender._id)
      senders++
    }

    const commands = await ctx.db
      .query("commands")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", now - COMMAND_TTL))
      .take(BATCH)
    for (const c of commands) await ctx.db.delete(c._id)

    return { taskStatus: statuses.length, inviteLinks: links.length, senders, commands: commands.length }
  },
})

/**
 * Every 10 minutes: deletes expired messages (undelivered after 7 days), expired pairing
 * requests (10 minutes) and finished rate limit windows. Bounded index ranges, as above.
 */
export const network = internalMutation({
  args: {},
  returns: v.object({ messages: v.number(), pairRequests: v.number(), rateLimits: v.number() }),
  handler: async (ctx) => {
    const now = Date.now()
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH)
    for (const m of messages) await ctx.db.delete(m._id)
    const pairRequests = await ctx.db
      .query("pairRequests")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH)
    for (const r of pairRequests) await ctx.db.delete(r._id)
    const rateLimits = await ctx.db
      .query("rateLimits")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(BATCH)
    for (const r of rateLimits) await ctx.db.delete(r._id)
    return { messages: messages.length, pairRequests: pairRequests.length, rateLimits: rateLimits.length }
  },
})

/**
 * Deploy step of v2: deletes the PIN sessions (the PIN path is closed in code already).
 * Run from the dashboard until it returns 0.
 */
export const dropPinSessions = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("pinSessions").take(BATCH)
    for (const r of rows) await ctx.db.delete(r._id)
    return rows.length
  },
})
