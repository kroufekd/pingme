import { v } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import { DAY, MAX_TITLE, createTask, currentMember, lastSeen, toQueued, touch } from "./model"
import { queuedCommand, recipient, repeat, snapTask, urgency } from "./validators"

/**
 * What the web page shows: the caller's own tasks from the Mac's list (while the page is open)
 * and the caller's own messages still on the way. Never anything of another sender.
 */
export const state = query({
  args: { token: v.optional(v.string()) },
  returns: v.union(
    v.object({ status: v.literal("signedOut") }),
    v.object({ status: v.literal("notInvited"), email: v.string() }),
    v.object({
      status: v.literal("member"),
      name: v.string(),
      macLastSeen: v.union(v.number(), v.null()),
      snapshot: v.union(v.object({ at: v.number(), tasks: v.array(snapTask) }), v.null()),
      queued: v.array(queuedCommand),
    }),
  ),
  handler: async (ctx, { token }) => {
    const m = await currentMember(ctx, token)
    if (m.status === "signedOut") return { status: "signedOut" as const }
    if (m.status === "notInvited") return { status: "notInvited" as const, email: m.email }
    const mine = m.senderId as string
    const snap = await ctx.db.query("snapshot").first()
    const commands = await ctx.db
      .query("commands")
      .withIndex("by_senderId", (q) => q.eq("senderId", m.senderId))
      .take(100)
    return {
      status: "member" as const,
      name: m.name,
      macLastSeen: await lastSeen(ctx, "mac"),
      snapshot: snap ? { at: snap.at, tasks: snap.tasks.filter((t) => t.senderId === mine) } : null,
      queued: commands.map(toQueued),
    }
  },
})

/** The page is open: asks the Mac to share its list. */
export const ping = mutation({
  args: { token: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, { token }) => {
    const m = await currentMember(ctx, token)
    if (m.status !== "member") return false
    await touch(ctx, "web", Date.now(), 10_000)
    return true
  },
})

export const create = mutation({
  args: {
    title: v.string(),
    dueAt: v.number(),
    followUpTitle: v.optional(v.string()),
    followUpMinutes: v.optional(v.number()),
    repeat: v.optional(repeat),
    token: v.optional(v.string()),
    urgency: v.optional(urgency),
    to: v.optional(recipient),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), id: v.string() }),
    v.object({ ok: v.literal(false), error: v.string() }),
  ),
  handler: async (ctx, args) => {
    const m = await currentMember(ctx, args.token)
    if (m.status !== "member") return { ok: false as const, error: "not-member" }
    const now = Date.now()
    const title = args.title.trim()
    if (!title || title.length > MAX_TITLE) return { ok: false as const, error: "bad-title" }
    if (!Number.isFinite(args.dueAt) || args.dueAt < now - DAY || args.dueAt > now + 60 * DAY) {
      return { ok: false as const, error: "bad-time" }
    }
    const followUpTitle = args.followUpTitle?.trim() || undefined
    let followUpMinutes: number | undefined
    if (followUpTitle) {
      const minutes = Math.round(args.followUpMinutes ?? 0)
      if (followUpTitle.length > MAX_TITLE || minutes < 1 || minutes > 24 * 60) {
        return { ok: false as const, error: "bad-follow-up" }
      }
      followUpMinutes = minutes
    }
    // A message for the agent goes out now, once: the Mac triages it as soon as it arrives.
    const agent = args.to === "agent"
    const id = await createTask(
      ctx,
      m.sender,
      {
        title,
        dueAt: agent ? now : Math.round(args.dueAt),
        urgency: args.urgency ?? "green",
        repeat: agent ? undefined : args.repeat,
        followUpTitle: agent ? undefined : followUpTitle,
        followUpMinutes: agent ? undefined : followUpMinutes,
        to: agent ? "agent" : undefined,
      },
      now,
    )
    await ctx.db.patch(m.senderId, { lastUsedAt: now })
    return { ok: true as const, id }
  },
})

/**
 * A sender can only take back its own task while it is still waiting in the queue.
 * Senders never send done/delete to the Mac: the Mac would apply them to any task.
 */
async function withdraw(ctx: MutationCtx, taskId: string, token?: string) {
  const m = await currentMember(ctx, token)
  if (m.status !== "member" || !taskId || taskId.length > 100) return false
  const queuedId = ctx.db.normalizeId("commands", taskId)
  const queued = queuedId ? await ctx.db.get(queuedId) : null
  if (!queued || queued.kind !== "create" || queued.senderId !== m.senderId) return false
  await ctx.db.delete(queued._id)
  const statuses = await ctx.db
    .query("taskStatus")
    .withIndex("by_taskRef", (q) => q.eq("taskRef", queued._id))
    .take(5)
  for (const s of statuses) if (s.senderId === m.senderId) await ctx.db.delete(s._id)
  return true
}

export const markDone = mutation({
  args: { taskId: v.string(), token: v.optional(v.string()) },
  returns: v.boolean(),
  handler: (ctx, { taskId, token }) => withdraw(ctx, taskId, token),
})

export const remove = mutation({
  args: { taskId: v.string(), token: v.optional(v.string()) },
  returns: v.boolean(),
  handler: (ctx, { taskId, token }) => withdraw(ctx, taskId, token),
})
