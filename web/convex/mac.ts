import { v } from "convex/values"
import { internalMutation, internalQuery } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import { TYPING_TTL, fingerprint, isWatching, statusExpiry, toQueued, touch } from "./model"
import { queuedCommand, snapTask, statusUpdate } from "./validators"
import type { StatusUpdate } from "./validators"

/** A v2 status row (from the commands queue). Network rows are never touched over MAC_TOKEN. */
async function statusRow(ctx: MutationCtx, taskRef: string) {
  const rows = await ctx.db
    .query("taskStatus")
    .withIndex("by_taskRef", (q) => q.eq("taskRef", taskRef))
    .take(5)
  return rows.find((r) => r.senderId !== undefined && r.toUserId === undefined) ?? null
}

/**
 * Applies one status from the Mac. Unknown taskRef (owner task or expired) is skipped.
 * A status older than the stored one is ignored, except over "queued": that one carries the
 * server clock, so a Mac clock running a bit behind must still be able to replace it.
 */
async function applyStatus(ctx: MutationCtx, s: StatusUpdate) {
  const row = await statusRow(ctx, s.taskRef)
  if (!row) return
  if (row.status !== "queued" && s.at < row.at) return
  const snoozed = s.status === "snoozed" && s.snoozedUntil !== undefined && s.snoozedUntil > 0
  const reply = s.reply?.trim()
  await ctx.db.patch(row._id, {
    status: s.status,
    at: s.at,
    snoozedUntil: snoozed ? s.snoozedUntil : undefined,
    expiresAt: statusExpiry(s.status, s.at, { replyAt: reply ? s.at : row.replyAt }),
    ...(reply ? { reply, replyAt: s.at } : {}),
    ...(reply || s.status === "done" ? { typingUntil: undefined } : {}),
  })
}

/**
 * One round trip of the Mac app: confirms the messages it already stored
 * (they are deleted here), reports task statuses and typing, shares its list
 * while someone has the web open, and gets the messages that are still waiting.
 */
export const sync = internalMutation({
  args: {
    ack: v.array(v.string()),
    tasks: v.optional(v.array(snapTask)),
    statuses: v.optional(v.array(statusUpdate)),
    typing: v.optional(v.string()),
  },
  returns: v.object({ now: v.number(), watching: v.boolean(), commands: v.array(queuedCommand) }),
  handler: async (ctx, { ack, tasks, statuses, typing }) => {
    const now = Date.now()
    for (const raw of ack) {
      const id = ctx.db.normalizeId("commands", raw)
      if (id && (await ctx.db.get(id))) await ctx.db.delete(id)
    }
    await touch(ctx, "mac", now, 30_000)

    for (const s of (statuses ?? []).slice(0, 100)) await applyStatus(ctx, s)
    if (typing) {
      const row = await statusRow(ctx, typing)
      if (row) await ctx.db.patch(row._id, { typingUntil: now + TYPING_TTL })
    }

    const watching = await isWatching(ctx, now)
    const snap = await ctx.db.query("snapshot").first()
    if (!watching) {
      if (snap) await ctx.db.delete(snap._id)
    } else if (tasks) {
      if (!snap) await ctx.db.insert("snapshot", { at: now, tasks })
      else if (fingerprint(snap.tasks) !== fingerprint(tasks)) await ctx.db.replace(snap._id, { at: now, tasks })
    }

    const commands = await ctx.db.query("commands").order("asc").take(50)
    return { now, watching, commands: commands.map(toQueued) }
  },
})

/** Removes the shared list once nobody has the web open, even if the Mac is asleep. */
export const dropStaleSnapshot = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    if (await isWatching(ctx, Date.now())) return null
    for (const snap of await ctx.db.query("snapshot").collect()) await ctx.db.delete(snap._id)
    return null
  },
})

// ---- First Mac app version ----
// Kept only because the platform does not allow removing internal functions.
// Nothing calls them: their HTTP routes answer 410 and tasks are no longer stored here.

/** @deprecated Tasks live on the Mac now. Use `sync`. */
export const state = internalQuery({
  args: {},
  handler: async () => ({ now: Date.now(), pending: [], done: [] }),
})

/** @deprecated Use `sync`, which also records the heartbeat. */
export const heartbeat = internalMutation({
  args: {},
  handler: async (ctx) => {
    await touch(ctx, "mac", Date.now(), 30_000)
  },
})

/** @deprecated Tasks live on the Mac now. */
export const create = internalMutation({
  args: {
    title: v.string(),
    dueAt: v.number(),
    followUpTitle: v.optional(v.string()),
    followUpMinutes: v.optional(v.number()),
  },
  handler: async () => ({ ok: false as const, error: "gone" }),
})

/** @deprecated Tasks live on the Mac now. */
export const done = internalMutation({ args: { id: v.string() }, handler: async () => false })

/** @deprecated Tasks live on the Mac now. */
export const snooze = internalMutation({
  args: { id: v.string(), minutes: v.number() },
  handler: async () => false,
})

/** @deprecated Tasks live on the Mac now. */
export const remove = internalMutation({ args: { id: v.string() }, handler: async () => false })
