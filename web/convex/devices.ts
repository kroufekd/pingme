import { getAuthUserId } from "@convex-dev/auth/server"
import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import { internalMutation, internalQuery, mutation, query } from "./_generated/server"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import { HOUR, MINUTE, safeEqual, sha256Hex } from "./model"
import {
  CLAIM_LIMIT,
  CODE_TRIES,
  PAIR_GUARD,
  PAIR_LIMIT,
  PAIR_TTL,
  RE_HASH,
  RE_KEY,
  RE_PAIR_ID,
  RE_TOKEN,
  activeDevices,
  cleanName,
  deviceForToken,
  hitLimit,
  inboxFor,
  isCiphertext,
  makeRoom,
  memberOf,
  nameOf,
  networkMember,
  pairCode,
} from "./network"
import { inboxItem } from "./validators"

// Devices: browsers register a key with Convex Auth, Macs pair through a signed-in browser
// that types the code shown on the Mac.

/**
 * The browser's key. Call on every load with the public key from IndexedDB: the same key
 * returns the same device. At most 10 web devices, the least recently seen one is revoked.
 */
export const registerWeb = mutation({
  args: { publicKey: v.string(), name: v.optional(v.string()) },
  returns: v.union(
    v.object({ ok: v.literal(true), deviceId: v.string() }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("not-member"), v.literal("bad-key")) }),
  ),
  handler: async (ctx, args) => {
    const m = await networkMember(ctx)
    if (!m) return { ok: false as const, error: "not-member" as const }
    if (!RE_KEY.test(args.publicKey)) return { ok: false as const, error: "bad-key" as const }
    const now = Date.now()
    const same = (await activeDevices(ctx, m.userId, "web")).find((d) => d.publicKey === args.publicKey)
    if (same) {
      if (now - same.lastSeen >= HOUR) await ctx.db.patch(same._id, { lastSeen: now })
      return { ok: true as const, deviceId: same._id as string }
    }
    await makeRoom(ctx, m.userId, "web", now)
    const deviceId = await ctx.db.insert("devices", {
      userId: m.userId,
      kind: "web",
      publicKey: args.publicKey,
      name: cleanName(args.name) || "Web",
      createdAt: now,
      lastSeen: now,
    })
    return { ok: true as const, deviceId: deviceId as string }
  },
})

/** Revokes one of the caller's own devices (web or Mac). */
export const revoke = mutation({
  args: { deviceId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const m = await networkMember(ctx)
    const id = ctx.db.normalizeId("devices", args.deviceId)
    const device = m && id ? await ctx.db.get(id) : null
    if (!m || !device || device.userId !== m.userId || device.revokedAt !== undefined) return false
    await ctx.db.patch(device._id, { revokedAt: Date.now() })
    return true
  },
})

// ---- Pairing a Mac ----

/** The request behind pairId when its secret hash matches. Says nothing otherwise. */
async function findRequest(ctx: QueryCtx, pairId: string, secretHash: string) {
  if (!RE_PAIR_ID.test(pairId) || !RE_HASH.test(secretHash)) return null
  const req = await ctx.db
    .query("pairRequests")
    .withIndex("by_pairId", (q) => q.eq("pairId", pairId))
    .first()
  return req && safeEqual(req.secretHash, secretHash) ? req : null
}

const pairingView = v.union(
  v.object({ status: v.literal("signedOut") }),
  v.object({ status: v.literal("notMember") }),
  v.object({ status: v.literal("invalid") }),
  v.object({ status: v.literal("pending"), name: v.string(), expiresAt: v.number() }),
  v.object({ status: v.literal("approved") }),
)

/**
 * What /pair shows: the Mac's name while the request waits. Wrong, expired or taken = invalid.
 * Never the code or the key: the code must come from the Mac's screen.
 */
export const pairing = query({
  args: { pairId: v.string(), secretHash: v.string() },
  returns: pairingView,
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { status: "signedOut" as const }
    if (!(await memberOf(ctx, userId))) return { status: "notMember" as const }
    const req = await findRequest(ctx, args.pairId, args.secretHash)
    if (!req) return { status: "invalid" as const }
    if (req.userId !== undefined) return req.userId === userId ? { status: "approved" as const } : { status: "invalid" as const }
    if (req.expiresAt <= Date.now()) return { status: "invalid" as const }
    return { status: "pending" as const, name: req.name, expiresAt: req.expiresAt }
  },
})

/**
 * The signed-in member takes the waiting Mac. The hash and the code shown on that Mac must
 * match, otherwise nothing is approved. CODE_TRIES wrong codes delete the request.
 */
export const approvePairing = mutation({
  args: { pairId: v.string(), secretHash: v.string(), code: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("not-member"), v.literal("invalid"), v.literal("bad-code")) }),
  ),
  handler: async (ctx, args) => {
    const m = await networkMember(ctx)
    if (!m) return { ok: false as const, error: "not-member" as const }
    const req = await findRequest(ctx, args.pairId, args.secretHash)
    const now = Date.now()
    if (!req || req.expiresAt <= now) return { ok: false as const, error: "invalid" as const }
    if (req.userId !== undefined) {
      return req.userId === m.userId ? { ok: true as const } : { ok: false as const, error: "invalid" as const }
    }
    if (!safeEqual(args.code.trim(), pairCode(req.pairId, req.publicKey))) {
      // A link alone must not be enough, and six digits must not be guessable by retrying.
      const misses = (req.codeMisses ?? 0) + 1
      if (misses >= CODE_TRIES) {
        await ctx.db.delete(req._id)
        return { ok: false as const, error: "invalid" as const }
      }
      await ctx.db.patch(req._id, { codeMisses: misses })
      return { ok: false as const, error: "bad-code" as const }
    }
    await ctx.db.patch(req._id, { userId: m.userId, approvedAt: now })
    return { ok: true as const }
  },
})

/** POST /device/pair/start. 10 per hour for the whole server (pairGuard). */
export const pairStart = internalMutation({
  args: { pairId: v.string(), secretHash: v.string(), publicKey: v.string(), name: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), expiresAt: v.number() }),
    v.object({
      ok: v.literal(false),
      error: v.union(v.literal("bad-request"), v.literal("pair-exists"), v.literal("rate-limited")),
    }),
  ),
  handler: async (ctx, args) => {
    const name = cleanName(args.name)
    if (!RE_PAIR_ID.test(args.pairId) || !RE_HASH.test(args.secretHash) || !RE_KEY.test(args.publicKey) || !name) {
      return { ok: false as const, error: "bad-request" as const }
    }
    const existing = await ctx.db
      .query("pairRequests")
      .withIndex("by_pairId", (q) => q.eq("pairId", args.pairId))
      .first()
    if (existing) return { ok: false as const, error: "pair-exists" as const }
    const now = Date.now()
    if (!(await hitLimit(ctx, PAIR_GUARD, PAIR_LIMIT, HOUR, now))) return { ok: false as const, error: "rate-limited" as const }
    const expiresAt = now + PAIR_TTL
    await ctx.db.insert("pairRequests", {
      pairId: args.pairId,
      secretHash: args.secretHash,
      publicKey: args.publicKey,
      name,
      createdAt: now,
      expiresAt,
    })
    return { ok: true as const, expiresAt }
  },
})

const sealedToken = v.object({ enc: v.string(), ct: v.string() })

const claimed = v.object({
  status: v.literal("approved"),
  sealedToken,
  deviceId: v.string(),
  userId: v.string(),
  name: v.string(),
})

/** The approved, already claimed request as the Mac gets it, or null when its device is gone. */
async function claimedView(ctx: MutationCtx, req: Doc<"pairRequests">) {
  const device = req.deviceId ? await ctx.db.get(req.deviceId) : null
  const user = req.userId ? await memberOf(ctx, req.userId) : null
  if (!req.sealedToken || !device || device.revokedAt !== undefined || !user) return null
  return {
    status: "approved" as const,
    sealedToken: req.sealedToken,
    deviceId: device._id as string,
    userId: user._id as string,
    name: nameOf(user),
  }
}

/**
 * POST /device/pair/claim, step one. Pending until approved. Once approved the first time it
 * answers "seal" with the Mac's key, and the HTTP action seals a fresh token to it (pairFinish).
 * After that every claim gets the same sealed token until the request expires: only the Mac
 * holding the private key can open it, so a stolen link is worth nothing here.
 */
export const pairClaim = internalMutation({
  args: { pairId: v.string(), secretHash: v.string() },
  returns: v.union(
    v.object({ status: v.literal("not-found") }),
    v.object({ status: v.literal("rate-limited") }),
    v.object({ status: v.literal("pending") }),
    v.object({ status: v.literal("seal"), publicKey: v.string(), userId: v.string() }),
    claimed,
  ),
  handler: async (ctx, args) => {
    const req = await findRequest(ctx, args.pairId, args.secretHash)
    const now = Date.now()
    if (!req || req.expiresAt <= now) return { status: "not-found" as const }
    if (!(await hitLimit(ctx, `claim:${req.pairId}`, CLAIM_LIMIT, MINUTE, now))) return { status: "rate-limited" as const }
    if (req.userId === undefined) return { status: "pending" as const }
    if (req.sealedToken) {
      const view = await claimedView(ctx, req)
      if (view) return view
      // Revoked in the meantime (or the person left): the pairing is over.
      await ctx.db.delete(req._id)
      return { status: "not-found" as const }
    }
    if (!(await memberOf(ctx, req.userId))) {
      await ctx.db.delete(req._id)
      return { status: "not-found" as const }
    }
    return { status: "seal" as const, publicKey: req.publicKey, userId: req.userId as string }
  },
})

/**
 * POST /device/pair/claim, step two: creates the Mac device with the token hash and keeps the
 * sealed token on the request. Two claims racing here make one device; the second gets the first's.
 */
export const pairFinish = internalMutation({
  args: { pairId: v.string(), secretHash: v.string(), userId: v.string(), tokenHash: v.string(), sealedToken },
  returns: v.union(v.object({ status: v.literal("not-found") }), claimed),
  handler: async (ctx, args) => {
    const req = await findRequest(ctx, args.pairId, args.secretHash)
    const now = Date.now()
    if (!req || req.expiresAt <= now || req.userId === undefined) return { status: "not-found" as const }
    if (req.sealedToken) return (await claimedView(ctx, req)) ?? { status: "not-found" as const }
    // The token must be sealed for this request's account and key, and look like HPKE output.
    if (
      (req.userId as string) !== args.userId ||
      !RE_HASH.test(args.tokenHash) ||
      !RE_KEY.test(args.sealedToken.enc) ||
      !isCiphertext(args.sealedToken.ct)
    ) {
      return { status: "not-found" as const }
    }
    const user = await memberOf(ctx, req.userId)
    if (!user) {
      await ctx.db.delete(req._id)
      return { status: "not-found" as const }
    }
    await makeRoom(ctx, user._id, "mac", now)
    const deviceId = await ctx.db.insert("devices", {
      userId: user._id,
      kind: "mac",
      publicKey: req.publicKey,
      tokenHash: args.tokenHash,
      name: req.name,
      createdAt: now,
      lastSeen: now,
    })
    const sealed = { enc: args.sealedToken.enc, ct: args.sealedToken.ct }
    await ctx.db.patch(req._id, { deviceId, sealedToken: sealed })
    return { status: "approved" as const, sealedToken: sealed, deviceId: deviceId as string, userId: user._id as string, name: nameOf(user) }
  },
})

// ---- The Mac's own calls ----

/** GET /device/me */
export const whoami = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({ ok: v.literal(true), deviceId: v.string(), userId: v.string(), name: v.string(), deviceName: v.string() }),
  ),
  handler: async (ctx, { tokenHash }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return { ok: false as const }
    return {
      ok: true as const,
      deviceId: auth.device._id as string,
      userId: auth.user._id as string,
      name: nameOf(auth.user),
      deviceName: auth.device.name,
    }
  },
})

/** POST /device/unpair: the Mac signs itself out for good. */
export const unpair = internalMutation({
  args: { tokenHash: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { tokenHash }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return false
    await ctx.db.patch(auth.device._id, { revokedAt: Date.now() })
    return true
  },
})

/** POST /device/devices/revoke: the Mac removes one of its person's devices (itself = unpair). */
export const revokeForDevice = internalMutation({
  args: { tokenHash: v.string(), deviceId: v.string() },
  returns: v.union(v.null(), v.boolean()),
  handler: async (ctx, args) => {
    const auth = await deviceForToken(ctx, args.tokenHash)
    if (!auth) return null
    const id = ctx.db.normalizeId("devices", args.deviceId)
    const device = id ? await ctx.db.get(id) : null
    if (!device || device.userId !== auth.user._id || device.revokedAt !== undefined) return false
    await ctx.db.patch(device._id, { revokedAt: Date.now() })
    return true
  },
})

/**
 * Live inbox for the Mac (a Convex subscription with the device token as `token`).
 * No clock: it reruns only when a message for this user arrives or leaves.
 */
export const feed = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({ ok: v.literal(true), deviceId: v.string(), messages: v.array(inboxItem) }),
  ),
  handler: async (ctx, { token }) => {
    if (!RE_TOKEN.test(token)) return { ok: false as const }
    const auth = await deviceForToken(ctx, sha256Hex(token))
    if (!auth) return { ok: false as const }
    return { ok: true as const, deviceId: auth.device._id as string, messages: await inboxFor(ctx, auth.device) }
  },
})
