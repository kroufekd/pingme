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

/** How soon the sender needs it: green = Can wait, orange = Soon, red = Now. */
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

// ---- Network (phase 2) ----

export const deviceKind = v.union(v.literal("mac"), v.literal("web"))
export type DeviceKind = Infer<typeof deviceKind>

/** One HPKE ciphertext sealed to one device. The server never sees the plaintext. */
export const envelope = v.object({ deviceId: v.id("devices"), enc: v.string(), ct: v.string() })
export type Envelope = Infer<typeof envelope>

/** An envelope as a client sends it (device id not yet checked). */
export const envelopeIn = v.object({ deviceId: v.string(), enc: v.string(), ct: v.string() })
export type EnvelopeIn = Infer<typeof envelopeIn>

/** The caller's own envelope, without the device id. */
export const sealed = v.object({ enc: v.string(), ct: v.string() })

/** A device another client may encrypt to. */
export const deviceInfo = v.object({ deviceId: v.string(), kind: deviceKind, publicKey: v.string() })
export type DeviceInfo = Infer<typeof deviceInfo>

/** One of the caller's own devices. */
export const myDevice = v.object({
  deviceId: v.string(),
  kind: deviceKind,
  publicKey: v.string(),
  name: v.string(),
  createdAt: v.number(),
  lastSeen: v.number(),
})

export const contactInfo = v.object({
  userId: v.string(),
  name: v.string(),
  hasMac: v.boolean(),
  online: v.boolean(),
  macLastSeen: v.union(v.number(), v.null()),
  devices: v.array(deviceInfo),
})
export type ContactInfo = Infer<typeof contactInfo>

/** A message waiting for one Mac device. */
export const inboxItem = v.object({
  ref: v.string(),
  fromUserId: v.union(v.string(), v.null()),
  fromName: v.string(),
  fromAgent: v.union(v.string(), v.null()),
  toUserId: v.string(),
  forAgent: v.boolean(),
  urgency,
  dueAt: v.number(),
  repeat: v.union(repeat, v.null()),
  createdAt: v.number(),
  expiresAt: v.number(),
  envelope: v.union(sealed, v.null()),
  text: v.union(v.string(), v.null()),
  unencrypted: v.boolean(),
})
export type InboxItem = Infer<typeof inboxItem>

/** A sent message as its sender sees it, with the caller device's envelopes only. */
export const sentRow = v.object({
  ref: v.string(),
  fromUserId: v.string(),
  toUserId: v.string(),
  toName: v.string(),
  fromAgent: v.union(v.string(), v.null()),
  forAgent: v.boolean(),
  urgency,
  dueAt: v.number(),
  repeat: v.union(repeat, v.null()),
  createdAt: v.number(),
  status: taskState,
  statusAt: v.number(),
  snoozedUntil: v.union(v.number(), v.null()),
  typingUntil: v.union(v.number(), v.null()),
  title: v.union(sealed, v.null()),
  reply: v.union(sealed, v.null()),
  replyAt: v.union(v.number(), v.null()),
})
export type SentRow = Infer<typeof sentRow>

/** One status change from a recipient device. Replies go through /device/reply. */
export const deviceStatus = v.object({
  ref: v.string(),
  status: taskState,
  at: v.number(),
  snoozedUntil: v.optional(v.number()),
})
export type DeviceStatus = Infer<typeof deviceStatus>
