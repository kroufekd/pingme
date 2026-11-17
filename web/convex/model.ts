import { getAuthUserId } from "@convex-dev/auth/server"
import type { Doc, Id } from "./_generated/dataModel"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import type { Recipient, Repeat, SnapTask, TaskState, Urgency } from "./validators"

export const MAX_TITLE = 200
export const MAX_REPLY = 200
export const MAX_NAME = 60
/** The web counts as open this long after its last ping. */
export const WATCH_TTL = 60_000

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR
/** A done task stays visible to its sender this long, anything else a week after its last change. */
export const DONE_TTL = DAY
export const STATUS_TTL = 7 * DAY
export const INVITE_TTL = 7 * DAY
/** "Píše" lasts this long after the Mac reports typing. */
export const TYPING_TTL = 6_000

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase()
}

export function isEmail(email: string) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

/** Compares two secrets without leaking where they differ. */
export function safeEqual(a: string, b: string) {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** True when `key` is the Mac's token. Without MAC_TOKEN set nothing matches. */
export function isMacKey(key: string) {
  const token = process.env.MAC_TOKEN
  return !!token && safeEqual(key, token)
}

// ---- SHA-256 ----
// Plain JS on purpose: it runs the same in queries, mutations and HTTP actions.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text: string) {
  const bytes = new TextEncoder().encode(text)
  const size = ((bytes.length + 9 + 63) >> 6) << 6
  const buf = new Uint8Array(size)
  buf.set(bytes)
  buf[bytes.length] = 0x80
  const view = new DataView(buf.buffer)
  const bits = bytes.length * 8
  view.setUint32(size - 8, Math.floor(bits / 0x100000000))
  view.setUint32(size - 4, bits >>> 0)

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const w = new Uint32Array(64)
  for (let off = 0; off < size; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("")
}

// ---- Who is calling ----

/** The active person sender of a Convex Auth user, if there is one. */
export async function activeSenderForUser(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("senders")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(5)
  return rows.find((s) => s.status === "active" && s.kind === "person") ?? null
}

/** The active agent sender for an API key hash, if there is one. */
export async function activeAgentForKeyHash(ctx: QueryCtx, keyHash: string) {
  if (!/^[0-9a-f]{64}$/.test(keyHash)) return null
  const rows = await ctx.db
    .query("senders")
    .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
    .take(5)
  return rows.find((s) => s.status === "active" && s.kind === "agent") ?? null
}

/**
 * Returns who is signed in. Only an active sender found by the Convex Auth user is a member.
 * The legacy PIN path is closed: any call that passes a `token` is signed out.
 * An email on the `invites` list alone is not a member (`notInvited`).
 */
export async function currentMember(ctx: QueryCtx, token?: string) {
  if (token !== undefined) return { status: "signedOut" as const }
  const userId = await getAuthUserId(ctx)
  if (!userId) return { status: "signedOut" as const }
  const user = await ctx.db.get(userId)
  const email = user?.email ? normalizeEmail(user.email) : ""
  const sender = await activeSenderForUser(ctx, userId)
  if (!sender) return { status: "notInvited" as const, email }
  return { status: "member" as const, email, name: sender.name, senderId: sender._id, sender }
}

// ---- Heartbeats ----

async function heartbeat(ctx: QueryCtx, device: "mac" | "web") {
  return await ctx.db
    .query("heartbeats")
    .withIndex("by_device", (q) => q.eq("device", device))
    .unique()
}

export async function lastSeen(ctx: QueryCtx, device: "mac" | "web") {
  return (await heartbeat(ctx, device))?.lastSeen ?? null
}

/** Records that a device is alive. Skips the write when the last one is recent. */
export async function touch(ctx: MutationCtx, device: "mac" | "web", now: number, minGap: number) {
  const hb = await heartbeat(ctx, device)
  if (!hb) await ctx.db.insert("heartbeats", { device, lastSeen: now })
  else if (now - hb.lastSeen >= minGap) await ctx.db.patch(hb._id, { lastSeen: now })
}

export async function isWatching(ctx: QueryCtx, now: number) {
  const web = await lastSeen(ctx, "web")
  return web !== null && now - web < WATCH_TTL
}

// ---- Tasks ----

export function statusExpiry(status: TaskState, at: number) {
  return at + (status === "done" ? DONE_TTL : STATUS_TTL)
}

/** Queues a new task from a sender and starts its status. The command id is the taskRef. */
export async function createTask(
  ctx: MutationCtx,
  sender: Doc<"senders">,
  task: {
    title: string
    dueAt: number
    urgency: Urgency
    repeat?: Repeat
    followUpTitle?: string
    followUpMinutes?: number
    to?: Recipient
  },
  now: number,
) {
  const id = await ctx.db.insert("commands", {
    kind: "create",
    title: task.title,
    dueAt: task.dueAt,
    followUpTitle: task.followUpTitle,
    followUpMinutes: task.followUpMinutes,
    repeat: task.repeat,
    urgency: task.urgency,
    to: task.to === "agent" ? "agent" : undefined,
    senderId: sender._id,
    senderKind: sender.kind,
    byName: sender.name,
    createdAt: now,
  })
  await ctx.db.insert("taskStatus", {
    senderId: sender._id,
    taskRef: id,
    status: "queued",
    at: now,
    expiresAt: statusExpiry("queued", now),
  })
  return id
}

/** The status row of a task, only when it belongs to `senderId`. */
export async function ownStatus(ctx: QueryCtx, senderId: Id<"senders">, taskRef: string) {
  if (!taskRef || taskRef.length > 100) return null
  const rows = await ctx.db
    .query("taskStatus")
    .withIndex("by_taskRef", (q) => q.eq("taskRef", taskRef))
    .take(5)
  return rows.find((r) => r.senderId === senderId) ?? null
}

export function toQueued(c: Doc<"commands">) {
  return {
    id: c._id as string,
    kind: c.kind,
    taskId: c.taskId,
    title: c.title,
    dueAt: c.dueAt,
    followUpTitle: c.followUpTitle,
    followUpMinutes: c.followUpMinutes,
    repeat: c.repeat,
    byName: c.byName,
    createdAt: c.createdAt,
    senderId: c.senderId as string | undefined,
    senderKind: c.senderKind,
    urgency: c.urgency,
    to: c.to,
  }
}

const KEYS = [
  "id", "title", "dueAt", "showAt", "byName", "source", "doneAt",
  "snoozeCount", "followUpTitle", "followUpMinutes", "followsFrom", "repeat",
  "senderId", "senderKind", "urgency", "to", "taskRef", "reply", "replyAt", "seenAt", "snoozedUntil",
] as const

/** Stable fingerprint, so an unchanged list is not written again. */
export function fingerprint(tasks: SnapTask[]) {
  return JSON.stringify(tasks.map((t) => KEYS.map((k) => t[k] ?? null)))
}
