import { v } from "convex/values"
import type { Infer } from "convex/values"

export const source = v.union(v.literal("web"), v.literal("mac"), v.literal("followup"))

/** How a task repeats. The Mac schedules the next one when the current one is done. */
export const repeat = v.union(
  v.literal("daily"),
  v.literal("weekdays"),
  v.literal("weekly"),
  v.literal("biweekly"),
  v.literal("monthly"),
)
export type Repeat = Infer<typeof repeat>

/** How soon the sender needs it: green = Počká, orange = Brzy, red = Hned. */
export const urgency = v.union(v.literal("green"), v.literal("orange"), v.literal("red"))
export type Urgency = Infer<typeof urgency>

/** Who a task is for: Dominik himself, or his agent (the Mac triages it with a small model first). */
export const recipient = v.union(v.literal("dominik"), v.literal("agent"))
export type Recipient = Infer<typeof recipient>

/** Who sent a task. The owner (Mac) has no sender. */
export const senderKind = v.union(v.literal("person"), v.literal("agent"))
export type SenderKind = Infer<typeof senderKind>

/** Live state of a sent task, as its sender sees it. */
export const taskState = v.union(
  v.literal("queued"),
  v.literal("waiting"),
  v.literal("popped"),
  v.literal("seen"),
  v.literal("replied"),
  v.literal("done"),
  v.literal("snoozed"),
)
export type TaskState = Infer<typeof taskState>

/** A task as the Mac reports it. Tasks are stored only on the Mac. */
export const snapTask = v.object({
  id: v.string(),
  title: v.string(),
  dueAt: v.number(),
  showAt: v.number(),
  byName: v.string(),
  source,
  doneAt: v.optional(v.number()),
  snoozeCount: v.number(),
  followUpTitle: v.optional(v.string()),
  followUpMinutes: v.optional(v.number()),
  followsFrom: v.optional(v.string()),
  repeat: v.optional(repeat),
  senderId: v.optional(v.string()),
  senderKind: v.optional(senderKind),
  urgency: v.optional(urgency),
  to: v.optional(recipient),
  taskRef: v.optional(v.string()),
  reply: v.optional(v.string()),
  replyAt: v.optional(v.number()),
  seenAt: v.optional(v.number()),
  snoozedUntil: v.optional(v.number()),
})
export type SnapTask = Infer<typeof snapTask>

export const commandKind = v.union(v.literal("create"), v.literal("done"), v.literal("delete"))

/** A message from the web waiting for the Mac to pick it up. */
export const queuedCommand = v.object({
  id: v.string(),
  kind: commandKind,
  taskId: v.optional(v.string()),
  title: v.optional(v.string()),
  dueAt: v.optional(v.number()),
  followUpTitle: v.optional(v.string()),
  followUpMinutes: v.optional(v.number()),
  repeat: v.optional(repeat),
  byName: v.string(),
  createdAt: v.number(),
  senderId: v.optional(v.string()),
  senderKind: v.optional(senderKind),
  urgency: v.optional(urgency),
  to: v.optional(recipient),
})

/** One status change from the Mac (sent through /mac/sync). */
export const statusUpdate = v.object({
  taskRef: v.string(),
  status: taskState,
  at: v.number(),
  snoozedUntil: v.optional(v.number()),
  reply: v.optional(v.string()),
})
export type StatusUpdate = Infer<typeof statusUpdate>
