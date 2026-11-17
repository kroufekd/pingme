import { v } from "convex/values"
import type { Infer } from "convex/values"
import { internalMutation, internalQuery, mutation, query } from "./_generated/server"
import { TYPING_TTL } from "./model"
import {
  SEEN_GAP,
  ackFor,
  applyDeviceStatus,
  deviceForToken,
  inboxFor,
  networkMember,
  receivedRow,
  replyCore,
  sendCore,
  sentRows,
  sentStatus,
} from "./network"
import { deviceInfo, deviceStatus, envelopeIn, inboxItem, sentRow } from "./validators"

// Pings between members. Text and replies are HPKE ciphertext made on the clients.

const sendArgs = {
  ref: v.string(),
  to: v.string(),
  forAgent: v.boolean(),
  urgency: v.string(),
  dueAt: v.optional(v.number()),
  repeat: v.optional(v.string()),
  envelopes: v.array(envelopeIn),
  titleEnvelopes: v.array(envelopeIn),
}

const sendError = v.union(
  v.literal("not-member"),
  v.literal("bad-ref"),
  v.literal("bad-urgency"),
  v.literal("bad-repeat"),
  v.literal("bad-time"),
  v.literal("bad-agent"),
  v.literal("bad-envelope"),
  v.literal("ref-taken"),
  v.literal("not-contact"),
  v.literal("no-device"),
  v.literal("stale-devices"),
  v.literal("rate-limited"),
)

const sendResult = v.union(
  v.object({ ok: v.literal(true), ref: v.string() }),
  v.object({
    ok: v.literal(false),
    error: sendError,
    devices: v.optional(v.array(deviceInfo)),
    myDevices: v.optional(v.array(deviceInfo)),
  }),
)

/** The web sends a ping. Contacts only (or yourself), one envelope per active Mac of the recipient. */
export const send = mutation({
  args: sendArgs,
  returns: sendResult,
  handler: async (ctx, args): Promise<Infer<typeof sendResult>> => {
    const m = await networkMember(ctx)
    if (!m) return { ok: false as const, error: "not-member" as const }
    return await sendCore(ctx, m.userId, args, Date.now())
  },
})

/**
 * The caller's sent pings with their live state. `deviceId` is this browser's device: only its
 * envelopes come back. `deviceActive` false means register the key again.
 */
export const mine = query({
  args: { deviceId: v.optional(v.string()) },
  returns: v.union(
    v.object({ status: v.literal("signedOut") }),
    v.object({ status: v.literal("notMember") }),
    v.object({ status: v.literal("member"), deviceActive: v.boolean(), rows: v.array(sentRow) }),
  ),
  handler: async (ctx, args) => {
    const m = await networkMember(ctx)
    if (!m) {
      const signedIn = (await ctx.auth.getUserIdentity()) !== null
      return signedIn ? { status: "notMember" as const } : { status: "signedOut" as const }
    }
    const id = args.deviceId ? ctx.db.normalizeId("devices", args.deviceId) : null
    const device = id ? await ctx.db.get(id) : null
    const active = !!device && device.userId === m.userId && device.revokedAt === undefined
    const rows = await sentRows(ctx, m.userId, active ? (device!._id as string) : null, Date.now())
    return { status: "member" as const, deviceActive: active, rows }
  },
})

/** This browser showed the reply: drops its copy of the reply. Other devices keep theirs. */
export const ackReply = mutation({
  args: { ref: v.string(), deviceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const m = await networkMember(ctx)
    if (!m) return false
    const st = await sentStatus(ctx, m.userId, args.ref)
    if (!st) return false
    const left = (st.replyEnvelopes ?? []).filter((e) => e.deviceId !== args.deviceId)
    if (left.length !== (st.replyEnvelopes ?? []).length) {
      await ctx.db.patch(st._id, { replyEnvelopes: left.length ? left : undefined })
    }
    return true
  },
})

// ---- Device API (called from deviceApi.ts with the hash of the device token) ----

const unauthorized = v.object({ ok: v.literal(false), error: v.literal("unauthorized") })

/** POST /device/sync: keep-alive, delivery acks, statuses, typing; answers the waiting messages. */
export const deviceSync = internalMutation({
  args: {
    tokenHash: v.string(),
    ack: v.array(v.string()),
    statuses: v.array(deviceStatus),
    typing: v.optional(v.string()),
  },
  returns: v.union(
    unauthorized,
    v.object({ ok: v.literal(true), now: v.number(), deviceId: v.string(), messages: v.array(inboxItem) }),
  ),
  handler: async (ctx, args) => {
    const auth = await deviceForToken(ctx, args.tokenHash)
    if (!auth) return { ok: false as const, error: "unauthorized" as const }
    const { device } = auth
    const now = Date.now()
    if (now - device.lastSeen >= SEEN_GAP) await ctx.db.patch(device._id, { lastSeen: now })
    await ackFor(ctx, device, args.ack)
    for (const s of args.statuses.slice(0, 100)) await applyDeviceStatus(ctx, device.userId, s, now)
    if (args.typing) {
      const row = await receivedRow(ctx, device.userId, args.typing)
      if (row) await ctx.db.patch(row._id, { typingUntil: now + TYPING_TTL })
    }
    return { ok: true as const, now, deviceId: device._id as string, messages: await inboxFor(ctx, device) }
  },
})

/** POST /device/reply */
export const deviceReply = internalMutation({
  args: {
    tokenHash: v.string(),
    ref: v.string(),
    at: v.number(),
    envelopes: v.optional(v.array(envelopeIn)),
    text: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({
      ok: v.literal(false),
      error: v.union(
        v.literal("unauthorized"),
        v.literal("not-found"),
        v.literal("bad-time"),
        v.literal("bad-envelope"),
        v.literal("bad-text"),
        v.literal("stale-devices"),
      ),
      devices: v.optional(v.array(deviceInfo)),
    }),
  ),
  handler: async (ctx, { tokenHash, ...input }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return { ok: false as const, error: "unauthorized" as const }
    return await replyCore(ctx, auth.device.userId, input, Date.now())
  },
})

/** POST /device/send: the Mac (its person or its agent) sends a ping. */
export const deviceSend = internalMutation({
  args: { tokenHash: v.string(), fromAgent: v.optional(v.string()), ...sendArgs },
  returns: v.union(unauthorized, sendResult),
  handler: async (ctx, { tokenHash, ...input }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return { ok: false as const, error: "unauthorized" as const }
    return await sendCore(ctx, auth.device.userId, input, Date.now())
  },
})

/** POST /device/sent: pings this Mac's person sent, with this device's envelopes. */
export const deviceSent = internalQuery({
  args: { tokenHash: v.string(), refs: v.optional(v.array(v.string())) },
  returns: v.union(unauthorized, v.object({ ok: v.literal(true), now: v.number(), rows: v.array(sentRow) })),
  handler: async (ctx, { tokenHash, refs }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return { ok: false as const, error: "unauthorized" as const }
    const now = Date.now()
    return { ok: true as const, now, rows: await sentRows(ctx, auth.device.userId, auth.device._id as string, now, refs) }
  },
})

