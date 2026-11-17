import { v } from "convex/values"
import type { Infer } from "convex/values"
import { mutation, query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { DONE_TTL, currentMember, lastSeen, ownStatus } from "./model"
import { recipient, repeat, taskState, urgency } from "./validators"
import type { SnapTask, TaskState } from "./validators"

const MAX_ROWS = 50

const row = v.object({
  taskRef: v.string(),
  title: v.union(v.string(), v.null()),
  urgency,
  to: v.optional(recipient),
  dueAt: v.union(v.number(), v.null()),
  repeat: v.optional(repeat),
  status: taskState,
  statusAt: v.number(),
  snoozedUntil: v.optional(v.number()),
  typingUntil: v.optional(v.number()),
  reply: v.optional(v.string()),
  replyAt: v.optional(v.number()),
  replyPending: v.boolean(),
  createdAt: v.number(),
})
type Row = Infer<typeof row>

/** Several snapshot rows can share a taskRef (repeats): the newest open one, else the newest done one. */
function pick(list: SnapTask[]) {
  const open = list.filter((t) => t.doneAt === undefined)
  if (open.length) return open.reduce((a, b) => (b.dueAt > a.dueAt ? b : a))
  return list.reduce((a, b) => ((b.doneAt ?? 0) > (a.doneAt ?? 0) ? b : a))
}

/** Best guess of the state when only the Mac's list knows the task (its status row expired). */
function stateFromSnapshot(t: SnapTask, now: number): { status: TaskState; at: number } {
  if (t.doneAt !== undefined) return { status: "done", at: t.doneAt }
  if (t.snoozedUntil !== undefined && t.snoozedUntil > now) return { status: "snoozed", at: t.showAt }
  if (t.seenAt !== undefined) return { status: "seen", at: t.seenAt }
  return t.showAt > now ? { status: "waiting", at: t.showAt } : { status: "popped", at: t.showAt }
}

/** The caller's own tasks with their live state. Built only from the caller's rows, always by index. */
export const mine = query({
  args: {},
  returns: v.union(
    v.object({ status: v.literal("signedOut") }),
    v.object({ status: v.literal("notMember") }),
    v.object({
      status: v.literal("member"),
      name: v.string(),
      macLastSeen: v.union(v.number(), v.null()),
      snapshotAt: v.union(v.number(), v.null()),
      rows: v.array(row),
    }),
  ),
  handler: async (ctx) => {
    const m = await currentMember(ctx)
    if (m.status === "signedOut") return { status: "signedOut" as const }
    if (m.status === "notInvited") return { status: "notMember" as const }
    const now = Date.now()
    const mine = m.senderId as string

    const commands = new Map<string, Doc<"commands">>()
    const queued = await ctx.db
      .query("commands")
      .withIndex("by_senderId", (q) => q.eq("senderId", m.senderId))
      .take(MAX_ROWS)
    for (const c of queued) if (c.kind === "create") commands.set(c._id, c)

    const statuses = new Map<string, Doc<"taskStatus">>()
    const rows = await ctx.db
      .query("taskStatus")
      .withIndex("by_senderId", (q) => q.eq("senderId", m.senderId))
      .order("desc")
      .take(200)
    for (const s of rows) if (!statuses.has(s.taskRef)) statuses.set(s.taskRef, s)

    const snap = await ctx.db.query("snapshot").first()
    const grouped = new Map<string, SnapTask[]>()
    for (const t of snap?.tasks ?? []) {
      if (t.senderId !== mine) continue
      const ref = t.taskRef ?? t.id
      grouped.set(ref, [...(grouped.get(ref) ?? []), t])
    }

    const refs = new Set([...commands.keys(), ...statuses.keys(), ...grouped.keys()])
    const out: Row[] = []
    for (const taskRef of refs) {
      const cmd = commands.get(taskRef)
      const st = statuses.get(taskRef)
      const list = grouped.get(taskRef)
      const sn = list ? pick(list) : undefined
      let status: TaskState
      let statusAt: number
      if (st) [status, statusAt] = [st.status, st.at]
      else if (cmd) [status, statusAt] = ["queued", cmd.createdAt]
      else {
        const guess = stateFromSnapshot(sn!, now)
        ;[status, statusAt] = [guess.status, guess.at]
      }
      if (status === "done" && statusAt < now - DONE_TTL) continue

      const snoozedUntil = status !== "snoozed" ? undefined : st ? st.snoozedUntil : sn?.snoozedUntil
      const replyPending = st?.reply !== undefined
      out.push({
        taskRef,
        title: cmd?.title ?? sn?.title ?? null,
        urgency: cmd?.urgency ?? sn?.urgency ?? "green",
        to: cmd?.to ?? sn?.to,
        dueAt: sn?.dueAt ?? cmd?.dueAt ?? null,
        repeat: sn?.repeat ?? cmd?.repeat,
        status,
        statusAt,
        snoozedUntil,
        typingUntil: st?.typingUntil,
        reply: replyPending ? st!.reply : sn?.reply,
        replyAt: replyPending ? st!.replyAt : sn?.replyAt,
        replyPending,
        createdAt: cmd?.createdAt ?? st?._creationTime ?? sn!.dueAt,
      })
    }
    out.sort((a, b) => b.createdAt - a.createdAt || (a.taskRef < b.taskRef ? -1 : 1))

    return {
      status: "member" as const,
      name: m.name,
      macLastSeen: await lastSeen(ctx, "mac"),
      snapshotAt: snap?.at ?? null,
      rows: out.slice(0, MAX_ROWS),
    }
  },
})

/** The web showed the reply: delete its text from the server. Only on the caller's own task. */
export const ackReply = mutation({
  args: { taskRef: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { taskRef }) => {
    const m = await currentMember(ctx)
    if (m.status !== "member") return false
    const st = await ownStatus(ctx, m.senderId, taskRef)
    if (!st) return false
    if (st.reply !== undefined || st.replyAt !== undefined) {
      await ctx.db.patch(st._id, { reply: undefined, replyAt: undefined })
    }
    return true
  },
})
