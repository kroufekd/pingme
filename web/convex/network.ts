import { getAuthUserId } from "@convex-dev/auth/server"
import type { Doc, Id } from "./_generated/dataModel"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import {
  DAY,
  DONE_TTL,
  HOUR,
  MAX_NAME,
  MAX_REPLY,
  MINUTE,
  activeSenderForUser,
  isEmail,
  normalizeEmail,
  sha256Hex,
  statusExpiry,
} from "./model"
import type { ContactInfo, DeviceInfo, DeviceKind, DeviceStatus, EnvelopeIn, InboxItem, Repeat, SentRow, TaskState, Urgency } from "./validators"

// Shared rules of the network: members, devices, contacts, envelopes, sends.
// The server only relays ciphertext. It checks who may talk to whom and which devices a
// ciphertext is for, never what it says.

export const MESSAGE_TTL = 7 * DAY
export const PAIR_TTL = 10 * MINUTE
/** A contact is online when one of its Macs checked in this recently. Macs check in every 5 min. */
export const ONLINE_TTL = 12 * MINUTE
/** lastSeen is written at most this often, so keep-alives do not rerun every contacts query. */
export const SEEN_GAP = 4 * MINUTE
/** Active devices per user and kind. The least recently seen one goes when a new one comes. */
export const MAX_DEVICES = 10
export const SEND_LIMIT = 30
export const PAIR_LIMIT = 10
export const INVITE_LIMIT = 10
export const MAX_OPEN_INVITES = 20
export const MAX_ENVELOPES = 2 * MAX_DEVICES
/** Base64 length of 800 bytes of text plus the 16 byte tag. Clients cap the text at 200 characters. */
export const MAX_CT = 1088
export const MIN_CT = 24
export const MAX_AGENT = 40
export const DEFAULT_WEB_URL = "https://pingme.macaly.app"
/** Name of the pairing start bucket in rateLimits. */
export const PAIR_GUARD = "pairGuard"
/** Claims per pairing request and minute. The Mac polls every 2 s (30 a minute). */
export const CLAIM_LIMIT = 60
/** Wrong codes on /pair before the request is thrown away. */
export const CODE_TRIES = 5

/** Raw 32-byte X25519 key or HPKE enc, standard base64. */
export const RE_KEY = /^[A-Za-z0-9+/]{43}=$/
/** Task reference made by the sender: 16 random bytes, base64url without padding. */
export const RE_REF = /^[A-Za-z0-9_-]{22}$/
/** Any ref a device may see: client refs and legacy refs (Convex ids). */
export const RE_ANY_REF = /^[A-Za-z0-9_-]{16,64}$/
/** Device token and pairing secret: 32 random bytes, base64url without padding. */
export const RE_TOKEN = /^[A-Za-z0-9_-]{43}$/
/** Pairing id: 16 random bytes, base64url without padding. */
export const RE_PAIR_ID = /^[A-Za-z0-9_-]{22}$/
export const RE_HASH = /^[0-9a-f]{64}$/
/** The pairing code the Mac shows and the person types on /pair. */
export const RE_CODE = /^[0-9]{6}$/

const URGENCIES = new Set(["green", "orange", "red"])
const REPEATS = new Set(["daily", "weekdays", "weekly", "biweekly", "monthly"])

export type Fail<E extends string> = { ok: false; error: E }
const fail = <E extends string>(error: E): Fail<E> => ({ ok: false, error })

export function isCiphertext(s: string) {
  return s.length >= MIN_CT && s.length <= MAX_CT && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s)
}

/** Trimmed single-line name, or "" when nothing usable is left. */
export function cleanName(raw: string | undefined, max = MAX_NAME) {
  // Control characters would break the one-line UI on the Mac.
  const s = (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
  return s.length > max ? "" : s
}

/**
 * Six digits shown on the Mac that started the pairing and typed on /pair, so approving needs
 * that Mac in front of you, not just its link. SHA-256 of "pairId|publicKey" (UTF-8), the first
 * 4 bytes as a big-endian unsigned integer, modulo 1 000 000, zero-padded to 6 digits.
 */
export function pairCode(pairId: string, publicKey: string) {
  const n = parseInt(sha256Hex(`${pairId}|${publicKey}`).slice(0, 8), 16) % 1_000_000
  return String(n).padStart(6, "0")
}

// ---- Random tokens (actions only: mutations and queries must not mint secrets) ----

export function base64url(bytes: Uint8Array) {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** 32 random bytes, base64url (43 characters). */
export function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

export function inviteUrl(token: string) {
  const web = (process.env.WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, "")
  return `${web}/?i=${token}`
}

// ---- Members ----

/** The user when it is a member: joined the network, or still an active person sender of v2. */
export async function memberOf(ctx: QueryCtx, userId: Id<"users">) {
  const user = await ctx.db.get(userId)
  if (!user) return null
  if (user.memberAt !== undefined) return user
  return (await activeSenderForUser(ctx, userId)) ? user : null
}

/** The signed-in member, or null. */
export async function networkMember(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx)
  if (!userId) return null
  const user = await memberOf(ctx, userId)
  return user ? { userId, user } : null
}

/** What others see as this person's name. */
export function nameOf(user: Doc<"users"> | null) {
  const name = cleanName(user?.name)
  if (name) return name
  const local = user?.email?.split("@")[0]?.trim()
  return local ? local.slice(0, MAX_NAME) : "?"
}

/** The owner's account (env OWNER_EMAIL), when it has signed in at least once. */
export async function ownerUser(ctx: QueryCtx) {
  const email = normalizeEmail(process.env.OWNER_EMAIL ?? "")
  if (!isEmail(email)) return null
  return await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", email))
    .first()
}

export function isOwnerEmail(email: string) {
  const owner = normalizeEmail(process.env.OWNER_EMAIL ?? "")
  return isEmail(owner) && normalizeEmail(email) === owner
}

/** Makes `user` a member, names it if it has no name yet and connects it with whoever invited it. */
export async function joinNetwork(
  ctx: MutationCtx,
  user: Doc<"users">,
  inviterId: Id<"users"> | null,
  name: string,
  now: number,
) {
  const patch: Partial<Doc<"users">> = {}
  if (user.memberAt === undefined) patch.memberAt = now
  const clean = cleanName(name)
  if (!cleanName(user.name) && clean) patch.name = clean
  if (inviterId && inviterId !== user._id && user.invitedBy === undefined) patch.invitedBy = inviterId
  if (Object.keys(patch).length) await ctx.db.patch(user._id, patch)
  if (inviterId) await ensureContact(ctx, inviterId, user._id, now)
}

/** Takes a person out of the network: membership, contacts, devices and open invite links. */
export async function removeMember(ctx: MutationCtx, userId: Id<"users">, now: number) {
  const user = await ctx.db.get(userId)
  if (!user) return
  if (user.memberAt !== undefined) await ctx.db.patch(userId, { memberAt: undefined })
  for (const c of await ctx.db.query("contacts").withIndex("by_a", (q) => q.eq("a", userId)).take(1000)) {
    await ctx.db.delete(c._id)
  }
  for (const c of await ctx.db.query("contacts").withIndex("by_b", (q) => q.eq("b", userId)).take(1000)) {
    await ctx.db.delete(c._id)
  }
  for (const d of await activeDevices(ctx, userId)) await ctx.db.patch(d._id, { revokedAt: now })
  const links = await ctx.db
    .query("inviteLinks")
    .withIndex("by_inviterId", (q) => q.eq("inviterId", userId))
    .take(200)
  for (const link of links) if (link.claimedAt === undefined) await ctx.db.delete(link._id)
  // Undelivered pings from and to this person: nobody should still get or hold them.
  const sent = await ctx.db
    .query("taskStatus")
    .withIndex("by_fromUserId", (q) => q.eq("fromUserId", userId))
    .take(1000)
  for (const st of sent) {
    const queued = await ctx.db
      .query("messages")
      .withIndex("by_ref", (q) => q.eq("ref", st.taskRef))
      .take(5)
    for (const m of queued) if (m.fromUserId === userId) await ctx.db.delete(m._id)
  }
  for (const m of await ctx.db.query("messages").withIndex("by_toUserId", (q) => q.eq("toUserId", userId)).take(1000)) {
    await ctx.db.delete(m._id)
  }
}

/** Drops an email from the code allowlist unless a member uses it. */
export async function dropAllowlistIfUnused(ctx: MutationCtx, email: string) {
  const normalized = normalizeEmail(email)
  if (isOwnerEmail(normalized)) return
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", normalized))
    .first()
  if (user && (await memberOf(ctx, user._id))) return
  const rows = await ctx.db
    .query("invites")
    .withIndex("by_email", (q) => q.eq("email", normalized))
    .take(10)
  for (const row of rows) await ctx.db.delete(row._id)
}

// ---- Contacts ----

function ordered(x: Id<"users">, y: Id<"users">): [Id<"users">, Id<"users">] {
  return (x as string) < (y as string) ? [x, y] : [y, x]
}

export async function areContacts(ctx: QueryCtx, x: Id<"users">, y: Id<"users">) {
  if (x === y) return false
  const [a, b] = ordered(x, y)
  const row = await ctx.db
    .query("contacts")
    .withIndex("by_a", (q) => q.eq("a", a).eq("b", b))
    .first()
  return row !== null
}

/** Creates the contact once. True when it was new. */
export async function ensureContact(ctx: MutationCtx, x: Id<"users">, y: Id<"users">, now: number) {
  if (x === y || (await areContacts(ctx, x, y))) return false
  const [a, b] = ordered(x, y)
  await ctx.db.insert("contacts", { a, b, createdAt: now })
  return true
}

export async function contactIds(ctx: QueryCtx, userId: Id<"users">) {
  const asA = await ctx.db.query("contacts").withIndex("by_a", (q) => q.eq("a", userId)).take(500)
  const asB = await ctx.db.query("contacts").withIndex("by_b", (q) => q.eq("b", userId)).take(500)
  return [...asA.map((c) => c.b), ...asB.map((c) => c.a)]
}

// ---- Devices ----

export async function activeDevices(ctx: QueryCtx, userId: Id<"users">, kind?: DeviceKind) {
  const rows = await ctx.db
    .query("devices")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .take(300)
  return rows.filter((d) => d.revokedAt === undefined && (kind === undefined || d.kind === kind))
}

export function deviceInfo(d: Doc<"devices">): DeviceInfo {
  return { deviceId: d._id as string, kind: d.kind, publicKey: d.publicKey }
}

/** Revokes the least recently seen devices of a kind so one more fits under MAX_DEVICES. */
export async function makeRoom(ctx: MutationCtx, userId: Id<"users">, kind: DeviceKind, now: number) {
  const list = (await activeDevices(ctx, userId, kind)).sort((a, b) => a.lastSeen - b.lastSeen)
  for (const d of list.slice(0, Math.max(0, list.length - (MAX_DEVICES - 1)))) {
    await ctx.db.patch(d._id, { revokedAt: now })
  }
}

/** The active Mac behind a device token hash, with its member. Checked inside every call. */
export async function deviceForToken(ctx: QueryCtx, tokenHash: string) {
  if (!RE_HASH.test(tokenHash)) return null
  const device = await ctx.db
    .query("devices")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .first()
  if (!device || device.kind !== "mac" || device.revokedAt !== undefined) return null
  const user = await memberOf(ctx, device.userId)
  return user ? { device, user } : null
}

async function isActiveDevice(ctx: QueryCtx, id: Id<"devices">) {
  const d = await ctx.db.get(id)
  return !!d && d.revokedAt === undefined
}

// ---- Rate limits ----

/** Counts one use in a fixed window. False (and nothing written) when the window is full. */
export async function hitLimit(ctx: MutationCtx, key: string, limit: number, windowMs: number, now: number) {
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first()
  if (!row) {
    await ctx.db.insert("rateLimits", { key, count: 1, windowStart: now, expiresAt: now + windowMs })
    return true
  }
  if (row.expiresAt <= now) {
    await ctx.db.patch(row._id, { count: 1, windowStart: now, expiresAt: now + windowMs })
    return true
  }
  if (row.count >= limit) return false
  await ctx.db.patch(row._id, { count: row.count + 1 })
  return true
}

// ---- Envelopes ----

type CheckedEnvelope = { deviceId: Id<"devices">; enc: string; ct: string }

/** Format checks only. Null when any envelope is malformed, repeated or the list is too long. */
export function parseEnvelopes(ctx: QueryCtx, list: EnvelopeIn[], max = MAX_ENVELOPES): CheckedEnvelope[] | null {
  if (list.length > max) return null
  const out: CheckedEnvelope[] = []
  const seen = new Set<string>()
  for (const e of list) {
    const deviceId = ctx.db.normalizeId("devices", e.deviceId)
    if (!deviceId || seen.has(deviceId) || !RE_KEY.test(e.enc) || !isCiphertext(e.ct)) return null
    seen.add(deviceId)
    out.push({ deviceId, enc: e.enc, ct: e.ct })
  }
  return out
}

// ---- Sending ----

export type SendInput = {
  ref: string
  to: string
  forAgent: boolean
  urgency: string
  dueAt?: number
  repeat?: string
  fromAgent?: string
  envelopes: EnvelopeIn[]
  titleEnvelopes: EnvelopeIn[]
}

export type SendError =
  | "bad-ref"
  | "bad-urgency"
  | "bad-repeat"
  | "bad-time"
  | "bad-agent"
  | "bad-envelope"
  | "ref-taken"
  | "not-contact"
  | "no-device"
  | "stale-devices"
  | "rate-limited"

export type SendResult =
  | { ok: true; ref: string }
  | { ok: false; error: SendError; devices?: DeviceInfo[]; myDevices?: DeviceInfo[] }

/**
 * Queues one ping. `envelopes` must be exactly the recipient's active Macs; `titleEnvelopes`
 * may only target the sender's own active devices. Same ref from the same sender to the same
 * recipient again is a retry and answers ok without writing.
 */
export async function sendCore(
  ctx: MutationCtx,
  fromUserId: Id<"users">,
  input: SendInput,
  now: number,
): Promise<SendResult> {
  if (!RE_REF.test(input.ref)) return fail("bad-ref")
  if (!URGENCIES.has(input.urgency)) return fail("bad-urgency")
  if (input.repeat !== undefined && !REPEATS.has(input.repeat)) return fail("bad-repeat")
  let dueAt = now
  if (!input.forAgent && input.dueAt !== undefined) {
    if (!Number.isFinite(input.dueAt) || input.dueAt < now - DAY || input.dueAt > now + 60 * DAY) return fail("bad-time")
    dueAt = Math.round(input.dueAt)
  }
  let fromAgent: string | undefined
  if (input.fromAgent !== undefined) {
    fromAgent = cleanName(input.fromAgent, MAX_AGENT)
    if (!fromAgent) return fail("bad-agent")
  }
  const envelopes = parseEnvelopes(ctx, input.envelopes, MAX_DEVICES)
  const titleEnvelopes = parseEnvelopes(ctx, input.titleEnvelopes)
  if (!envelopes || !titleEnvelopes) return fail("bad-envelope")

  const toUserId = ctx.db.normalizeId("users", input.to)
  if (!toUserId) return fail("not-contact")

  const ref = input.ref
  const taken = await ctx.db
    .query("taskStatus")
    .withIndex("by_taskRef", (q) => q.eq("taskRef", ref))
    .take(5)
  const queued = await ctx.db
    .query("messages")
    .withIndex("by_ref", (q) => q.eq("ref", ref))
    .take(5)
  if (taken.length || queued.length) {
    const same = [...taken, ...queued].every((r) => r.fromUserId === fromUserId && r.toUserId === toUserId)
    return same ? { ok: true, ref } : fail("ref-taken")
  }

  // Yourself (another of your Macs) needs no contact.
  if (toUserId !== fromUserId) {
    if (!(await memberOf(ctx, toUserId)) || !(await areContacts(ctx, fromUserId, toUserId))) return fail("not-contact")
  }

  const macs = await activeDevices(ctx, toUserId, "mac")
  if (!macs.length) return fail("no-device")
  const mine = await activeDevices(ctx, fromUserId)
  const want = new Set(macs.map((d) => d._id as string))
  const own = new Set(mine.map((d) => d._id as string))
  const exact = envelopes.length === want.size && envelopes.every((e) => want.has(e.deviceId))
  if (!exact || !titleEnvelopes.every((e) => own.has(e.deviceId))) {
    return { ok: false, error: "stale-devices", devices: macs.map(deviceInfo), myDevices: mine.map(deviceInfo) }
  }

  if (!(await hitLimit(ctx, `send:${fromUserId}:${toUserId}`, SEND_LIMIT, HOUR, now))) return fail("rate-limited")

  const repeat = input.forAgent ? undefined : (input.repeat as Repeat | undefined)
  const urgency = input.urgency as Urgency
  await ctx.db.insert("messages", {
    ref,
    fromUserId,
    fromAgent,
    toUserId,
    forAgent: input.forAgent,
    urgency,
    dueAt,
    repeat,
    createdAt: now,
    expiresAt: now + MESSAGE_TTL,
    envelopes,
    deliveredTo: [],
  })
  await ctx.db.insert("taskStatus", {
    fromUserId,
    toUserId,
    taskRef: ref,
    status: "queued",
    at: now,
    expiresAt: statusExpiry("queued", now),
    fromAgent,
    forAgent: input.forAgent,
    urgency,
    dueAt,
    repeat,
    createdAt: now,
    titleEnvelopes,
  })
  return { ok: true, ref }
}

/**
 * Legacy remote MCP: an agent key sends plaintext to the owner. Stored flagged as unencrypted and
 * delivered to every active Mac of the owner. The ref is the message id. Not to be extended.
 */
export async function createLegacyMessage(
  ctx: MutationCtx,
  sender: Doc<"senders">,
  ownerId: Id<"users">,
  title: string,
  urgency: Urgency,
  now: number,
) {
  const id = await ctx.db.insert("messages", {
    ref: "",
    fromSenderId: sender._id,
    fromName: sender.name,
    fromAgent: "mcp",
    toUserId: ownerId,
    forAgent: false,
    urgency,
    dueAt: now,
    createdAt: now,
    expiresAt: now + MESSAGE_TTL,
    envelopes: [],
    deliveredTo: [],
    text: title,
    unencrypted: true,
  })
  const ref = id as string
  await ctx.db.patch(id, { ref })
  await ctx.db.insert("taskStatus", {
    senderId: sender._id,
    toUserId: ownerId,
    taskRef: ref,
    status: "queued",
    at: now,
    expiresAt: statusExpiry("queued", now),
    fromAgent: "mcp",
    forAgent: false,
    urgency,
    dueAt: now,
    createdAt: now,
    unencrypted: true,
  })
  return ref
}

/** The owner, when it has an active Mac to take legacy MCP messages. Else they stay on the v2 queue. */
export async function ownerWithMac(ctx: QueryCtx) {
  const owner = await ownerUser(ctx)
  if (!owner) return null
  return (await activeDevices(ctx, owner._id, "mac")).length ? owner : null
}

// ---- Receiving (recipient Mac) ----

async function namer(ctx: QueryCtx) {
  const cache = new Map<string, string>()
  return async (id: Id<"users">) => {
    const hit = cache.get(id)
    if (hit !== undefined) return hit
    const name = nameOf(await ctx.db.get(id))
    cache.set(id, name)
    return name
  }
}

/** Messages still waiting for this device, oldest first, at most 50. Only its own envelope. */
export async function inboxFor(ctx: QueryCtx, device: Doc<"devices">): Promise<InboxItem[]> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_toUserId", (q) => q.eq("toUserId", device.userId))
    .order("asc")
    .take(300)
  const name = await namer(ctx)
  const out: InboxItem[] = []
  for (const m of rows) {
    if (m.deliveredTo.includes(device._id)) continue
    const env = m.unencrypted ? null : m.envelopes.find((e) => e.deviceId === device._id)
    if (!m.unencrypted && !env) continue
    out.push({
      ref: m.ref,
      fromUserId: (m.fromUserId as string | undefined) ?? null,
      fromName: m.fromUserId ? await name(m.fromUserId) : (m.fromName ?? "?"),
      fromAgent: m.fromAgent ?? null,
      toUserId: m.toUserId as string,
      forAgent: m.forAgent,
      urgency: m.urgency,
      dueAt: m.dueAt,
      repeat: m.repeat ?? null,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt,
      envelope: env ? { enc: env.enc, ct: env.ct } : null,
      text: m.unencrypted ? (m.text ?? "") : null,
      unencrypted: m.unencrypted === true,
    })
    if (out.length >= 50) break
  }
  return out
}

/** Marks messages as delivered to this device. A message goes once every active target has it. */
export async function ackFor(ctx: MutationCtx, device: Doc<"devices">, refs: string[]) {
  for (const ref of refs.slice(0, 100)) {
    if (!RE_ANY_REF.test(ref)) continue
    const rows = await ctx.db
      .query("messages")
      .withIndex("by_ref", (q) => q.eq("ref", ref))
      .take(5)
    const m = rows.find((r) => r.toUserId === device.userId)
    if (!m) continue
    if (!m.unencrypted && !m.envelopes.some((e) => e.deviceId === device._id)) continue
    const delivered = m.deliveredTo.includes(device._id) ? m.deliveredTo : [...m.deliveredTo, device._id]
    const targets = m.unencrypted
      ? (await activeDevices(ctx, m.toUserId, "mac")).map((d) => d._id)
      : m.envelopes.map((e) => e.deviceId)
    let open = false
    for (const id of targets) {
      if (!delivered.includes(id) && (await isActiveDevice(ctx, id))) {
        open = true
        break
      }
    }
    if (open) await ctx.db.patch(m._id, { deliveredTo: delivered })
    else await ctx.db.delete(m._id)
  }
}

/** The status row of a message sent to `userId`. Never a row of someone else's message. */
export async function receivedRow(ctx: QueryCtx, userId: Id<"users">, ref: string) {
  if (!RE_ANY_REF.test(ref)) return null
  const rows = await ctx.db
    .query("taskStatus")
    .withIndex("by_taskRef", (q) => q.eq("taskRef", ref))
    .take(5)
  return rows.find((r) => r.toUserId === userId) ?? null
}

/** The status row of a message `userId` sent. */
export async function sentStatus(ctx: QueryCtx, userId: Id<"users">, ref: string) {
  if (!RE_ANY_REF.test(ref)) return null
  const rows = await ctx.db
    .query("taskStatus")
    .withIndex("by_taskRef", (q) => q.eq("taskRef", ref))
    .take(5)
  return rows.find((r) => r.fromUserId === userId) ?? null
}

const DEVICE_STATES = new Set<TaskState>(["waiting", "popped", "seen", "done", "snoozed"])

/** True when `at` is a sane time from a device clock. */
export function saneAt(at: number, now: number) {
  return Number.isFinite(at) && at > 0 && at <= now + HOUR
}

/**
 * Applies one status from a recipient device. Older than the stored one is ignored, except over
 * "queued" (it carries the server clock, a Mac clock a bit behind must still replace it).
 */
export async function applyDeviceStatus(ctx: MutationCtx, userId: Id<"users">, s: DeviceStatus, now: number) {
  if (!DEVICE_STATES.has(s.status) || !saneAt(s.at, now)) return
  const row = await receivedRow(ctx, userId, s.ref)
  if (!row) return
  if (row.status !== "queued" && s.at < row.at) return
  const snoozed = s.status === "snoozed" && s.snoozedUntil !== undefined && s.snoozedUntil > 0
  await ctx.db.patch(row._id, {
    status: s.status,
    at: s.at,
    snoozedUntil: snoozed ? s.snoozedUntil : undefined,
    expiresAt: statusExpiry(s.status, s.at),
    ...(s.status === "done" ? { typingUntil: undefined } : {}),
  })
}

export type ReplyError = "not-found" | "bad-time" | "bad-envelope" | "bad-text" | "stale-devices"

/**
 * A reply from the recipient: envelopes for the sender's active devices (at least one must still
 * be active; envelopes for gone devices are dropped). Legacy unencrypted rows take `text`.
 */
export async function replyCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  input: { ref: string; at: number; envelopes?: EnvelopeIn[]; text?: string },
  now: number,
): Promise<{ ok: true } | { ok: false; error: ReplyError; devices?: DeviceInfo[] }> {
  const row = await receivedRow(ctx, userId, input.ref)
  if (!row) return fail("not-found")
  if (!saneAt(input.at, now)) return fail("bad-time")
  // The reply is always kept; the status moves only forward (an older retry must not undo "done").
  const advance = row.status === "queued" || input.at >= row.at
  const status: Partial<Doc<"taskStatus">> = advance
    ? { status: "replied", at: input.at, snoozedUntil: undefined, expiresAt: statusExpiry("replied", input.at) }
    : {}

  if (row.unencrypted) {
    const text = (input.text ?? "").trim()
    if (!text || text.length > MAX_REPLY) return fail("bad-text")
    await ctx.db.patch(row._id, { ...status, reply: text, replyAt: input.at, typingUntil: undefined })
    return { ok: true }
  }
  // Plaintext is never accepted for a network message.
  if (input.text !== undefined) return fail("bad-text")
  if (!row.fromUserId) return fail("not-found")
  const envelopes = parseEnvelopes(ctx, input.envelopes ?? [])
  if (!envelopes || !envelopes.length) return fail("bad-envelope")
  const senderDevices = await activeDevices(ctx, row.fromUserId)
  const ids = new Set(senderDevices.map((d) => d._id as string))
  const kept = envelopes.filter((e) => ids.has(e.deviceId))
  if (!kept.length) return { ok: false, error: "stale-devices", devices: senderDevices.map(deviceInfo) }
  await ctx.db.patch(row._id, { ...status, replyEnvelopes: kept, replyAt: input.at, typingUntil: undefined })
  return { ok: true }
}

// ---- Sender's view ----

/** Rows of messages `userId` sent, newest first. Envelopes only for `deviceId`. */
export async function sentRows(
  ctx: QueryCtx,
  userId: Id<"users">,
  deviceId: string | null,
  now: number,
  refs?: string[],
): Promise<SentRow[]> {
  let rows: Doc<"taskStatus">[]
  if (refs) {
    rows = []
    for (const ref of refs.slice(0, 50)) {
      const row = await sentStatus(ctx, userId, ref)
      if (row) rows.push(row)
    }
  } else {
    rows = await ctx.db
      .query("taskStatus")
      .withIndex("by_fromUserId", (q) => q.eq("fromUserId", userId))
      .order("desc")
      .take(200)
  }
  const name = await namer(ctx)
  const out: SentRow[] = []
  for (const st of rows) {
    if (!st.toUserId) continue
    if (!refs && st.status === "done" && st.at < now - DONE_TTL) continue
    const title = deviceId ? st.titleEnvelopes?.find((e) => e.deviceId === deviceId) : undefined
    const reply = deviceId ? st.replyEnvelopes?.find((e) => e.deviceId === deviceId) : undefined
    out.push({
      ref: st.taskRef,
      fromUserId: userId as string,
      toUserId: st.toUserId as string,
      toName: await name(st.toUserId),
      fromAgent: st.fromAgent ?? null,
      forAgent: st.forAgent ?? false,
      urgency: st.urgency ?? "green",
      dueAt: st.dueAt ?? st.at,
      repeat: st.repeat ?? null,
      createdAt: st.createdAt ?? st._creationTime,
      status: st.status,
      statusAt: st.at,
      snoozedUntil: st.status === "snoozed" ? (st.snoozedUntil ?? null) : null,
      typingUntil: st.typingUntil ?? null,
      title: title ? { enc: title.enc, ct: title.ct } : null,
      reply: reply ? { enc: reply.enc, ct: reply.ct } : null,
      replyAt: st.replyAt ?? null,
    })
    if (out.length >= 50) break
  }
  return out
}

// ---- Contacts view ----

/** The caller's own devices and its contacts with their devices. */
export async function contactsView(ctx: QueryCtx, user: Doc<"users">, now: number) {
  const mine = await activeDevices(ctx, user._id)
  const contacts: ContactInfo[] = []
  for (const id of await contactIds(ctx, user._id)) {
    const other = await memberOf(ctx, id)
    if (!other) continue
    const devices = await activeDevices(ctx, id)
    const macs = devices.filter((d) => d.kind === "mac")
    const macLastSeen = macs.length ? Math.max(...macs.map((d) => d.lastSeen)) : null
    contacts.push({
      userId: id as string,
      name: nameOf(other),
      hasMac: macs.length > 0,
      online: macLastSeen !== null && now - macLastSeen < ONLINE_TTL,
      macLastSeen,
      devices: devices.map(deviceInfo),
    })
  }
  // Plain compare: locale data in the Convex runtime is not guaranteed.
  const key = (c: ContactInfo) => `${c.name.toLowerCase()}\u0000${c.userId}`
  contacts.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  return {
    me: {
      userId: user._id as string,
      name: nameOf(user),
      devices: mine.map((d) => ({
        deviceId: d._id as string,
        kind: d.kind,
        publicKey: d.publicKey,
        name: d.name,
        createdAt: d.createdAt,
        lastSeen: d.lastSeen,
      })),
    },
    contacts,
  }
}
