import { getAuthUserId } from "@convex-dev/auth/server"
import { v, type Infer } from "convex/values"
import { internal } from "./_generated/api"
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { HOUR, INVITE_TTL, activeSenderForUser, isEmail, normalizeEmail, sha256Hex } from "./model"
import {
  INVITE_LIMIT,
  MAX_OPEN_INVITES,
  RE_HASH,
  areContacts,
  cleanName,
  deviceForToken,
  dropAllowlistIfUnused,
  hitLimit,
  inviteUrl,
  joinNetwork,
  memberOf,
  nameOf,
  networkMember,
  ownerUser,
  randomToken,
} from "./network"

// Invite links. Legacy links come from the owner's Mac (MAC_TOKEN) and carry a `senders` row.
// Network links come from any member (inviterId); claiming one makes a contact both ways and
// never creates a `senders` row, so the plaintext v2 path stays closed to new people.

type Open = {
  link: Doc<"inviteLinks">
  name: string
  inviterId: Id<"users"> | null
  inviterName?: string
  sender: Doc<"senders"> | null
}

/** The link behind `token` while it can still be used: not claimed, not expired, inviter still in. */
async function openLink(ctx: QueryCtx, token: string, now: number): Promise<Open | null> {
  if (!token || token.length > 200) return null
  const tokenHash = sha256Hex(token)
  const link = await ctx.db
    .query("inviteLinks")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .first()
  if (!link || link.claimedAt !== undefined || link.expiresAt <= now) return null
  if (link.inviterId) {
    const inviter = await memberOf(ctx, link.inviterId)
    if (!inviter) return null
    return { link, name: link.name ?? "", inviterId: link.inviterId, inviterName: nameOf(inviter), sender: null }
  }
  if (!link.senderId) return null
  const sender = await ctx.db.get(link.senderId)
  if (!sender || sender.kind !== "person" || sender.status !== "invited") return null
  const owner = await ownerUser(ctx)
  return { link, name: sender.name, inviterId: null, inviterName: owner ? nameOf(owner) : undefined, sender }
}

/** Whether an invite link still works, the invited name and who invites. Says nothing else. */
export const check = query({
  args: { token: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), name: v.string(), inviterName: v.optional(v.string()) }),
    v.object({ ok: v.literal(false) }),
  ),
  handler: async (ctx, { token }) => {
    const open = await openLink(ctx, token, Date.now())
    if (!open) return { ok: false as const }
    return open.inviterName === undefined
      ? { ok: true as const, name: open.name }
      : { ok: true as const, name: open.name, inviterName: open.inviterName }
  },
})

/** Ties an email to the link and lets the code be sent to it. The web then signs in with that email. */
export const start = mutation({
  args: { token: v.string(), email: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true) }),
    v.object({ ok: v.literal(false), error: v.union(v.literal("bad-link"), v.literal("bad-email")) }),
  ),
  handler: async (ctx, args) => {
    const now = Date.now()
    const open = await openLink(ctx, args.token, now)
    if (!open) return { ok: false as const, error: "bad-link" as const }
    const email = normalizeEmail(args.email)
    if (!isEmail(email)) return { ok: false as const, error: "bad-email" as const }
    await ctx.db.patch(open.link._id, { email })
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first()
    if (!invite) await ctx.db.insert("invites", { email, name: open.name, createdAt: now })
    return { ok: true as const }
  },
})

/** After the code: the signed-in person joins (and, on a legacy link, becomes its sender). */
export const claim = mutation({
  // addContact: an existing member said yes to this inviter. Without it a member only gets "confirm":
  // anyone who knows a member's email could otherwise send a link that adds itself on open.
  args: { token: v.string(), addContact: v.optional(v.boolean()) },
  returns: v.union(
    v.object({ ok: v.literal(true), name: v.string() }),
    v.object({ ok: v.literal(false), error: v.literal("confirm"), inviterName: v.string() }),
    v.object({
      ok: v.literal(false),
      error: v.union(v.literal("bad-link"), v.literal("wrong-email"), v.literal("signed-out")),
    }),
  ),
  handler: async (ctx, { token, addContact }) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { ok: false as const, error: "signed-out" as const }
    const now = Date.now()
    const open = await openLink(ctx, token, now)
    if (!open) return { ok: false as const, error: "bad-link" as const }
    const user = await ctx.db.get(userId)
    const email = user?.email ? normalizeEmail(user.email) : ""
    if (!user || !email || !open.link.email || email !== open.link.email) {
      return { ok: false as const, error: "wrong-email" as const }
    }
    if (open.inviterId && user.memberAt !== undefined && !addContact && !(await areContacts(ctx, open.inviterId, userId))) {
      return { ok: false as const, error: "confirm" as const, inviterName: open.inviterName ?? open.name }
    }
    await ctx.db.patch(open.link._id, { claimedAt: now })

    if (open.inviterId) {
      // A legacy invite moved to the network by the migration: its waiting sender is not needed.
      if (open.link.senderId) {
        const waiting = await ctx.db.get(open.link.senderId)
        if (waiting && waiting.status === "invited") await ctx.db.delete(waiting._id)
      }
      await joinNetwork(ctx, user, open.inviterId, open.name, now)
      return { ok: true as const, name: nameOf(await ctx.db.get(userId)) }
    }

    // Legacy link from the owner's Mac.
    const owner = await ownerUser(ctx)
    const existing = await activeSenderForUser(ctx, userId)
    if (existing) {
      // Already in under another sender: keep that one, drop the new one.
      await ctx.db.delete(open.sender!._id)
      await joinNetwork(ctx, user, owner?._id ?? null, existing.name, now)
      return { ok: true as const, name: existing.name }
    }
    await ctx.db.patch(open.sender!._id, { userId, email, status: "active" })
    await joinNetwork(ctx, user, owner?._id ?? null, open.sender!.name, now)
    return { ok: true as const, name: open.sender!.name }
  },
})

// ---- Network invites (any member) ----

const inviteRow = v.object({
  inviteId: v.string(),
  name: v.string(),
  email: v.union(v.string(), v.null()),
  createdAt: v.number(),
  expiresAt: v.number(),
})

const createError = v.union(
  v.literal("not-member"),
  v.literal("bad-name"),
  v.literal("too-many-invites"),
  v.literal("rate-limited"),
)

const created = v.union(
  v.object({ ok: v.literal(true), inviteId: v.string(), expiresAt: v.number() }),
  v.object({ ok: v.literal(false), error: createError }),
)

async function createNetworkInvite(
  ctx: MutationCtx,
  inviterId: Id<"users">,
  rawName: string,
  linkHash: string,
  now: number,
) {
  const name = cleanName(rawName)
  if (!name) return { ok: false as const, error: "bad-name" as const }
  if (!RE_HASH.test(linkHash)) throw new Error("bad link hash")
  const links = await ctx.db
    .query("inviteLinks")
    .withIndex("by_inviterId", (q) => q.eq("inviterId", inviterId))
    .take(200)
  const open = links.filter((l) => l.claimedAt === undefined && l.expiresAt > now)
  if (open.length >= MAX_OPEN_INVITES) return { ok: false as const, error: "too-many-invites" as const }
  if (!(await hitLimit(ctx, `invite:${inviterId}`, INVITE_LIMIT, HOUR, now))) {
    return { ok: false as const, error: "rate-limited" as const }
  }
  const expiresAt = now + INVITE_TTL
  const inviteId = await ctx.db.insert("inviteLinks", { tokenHash: linkHash, inviterId, name, createdAt: now, expiresAt })
  return { ok: true as const, inviteId: inviteId as string, expiresAt }
}

async function openInvites(ctx: QueryCtx, inviterId: Id<"users">, now: number) {
  const links = await ctx.db
    .query("inviteLinks")
    .withIndex("by_inviterId", (q) => q.eq("inviterId", inviterId))
    .take(200)
  return links
    .filter((l) => l.claimedAt === undefined && l.expiresAt > now)
    .sort((a, b) => (b.createdAt ?? b._creationTime) - (a.createdAt ?? a._creationTime))
    .map((l) => ({
      inviteId: l._id as string,
      name: l.name ?? "",
      email: l.email ?? null,
      createdAt: l.createdAt ?? l._creationTime,
      expiresAt: l.expiresAt,
    }))
}

async function revokeInvite(ctx: MutationCtx, inviterId: Id<"users">, rawId: string) {
  const id = ctx.db.normalizeId("inviteLinks", rawId)
  const link = id ? await ctx.db.get(id) : null
  if (!link || link.inviterId !== inviterId || link.claimedAt !== undefined) return false
  await ctx.db.delete(link._id)
  if (link.senderId) {
    const waiting = await ctx.db.get(link.senderId)
    if (waiting && waiting.status === "invited") await ctx.db.delete(waiting._id)
  }
  if (link.email) await dropAllowlistIfUnused(ctx, link.email)
  return true
}

/** The web makes an invite link for a name. The link works once, for 7 days. */
export const create = action({
  args: { name: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), inviteId: v.string(), url: v.string(), expiresAt: v.number() }),
    v.object({ ok: v.literal(false), error: createError }),
  ),
  handler: async (
    ctx,
    { name },
  ): Promise<{ ok: true; inviteId: string; url: string; expiresAt: number } | { ok: false; error: Infer<typeof createError> }> => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { ok: false as const, error: "not-member" as const }
    const token = randomToken()
    // Annotated: an action calling a mutation in its own file needs it, or the types go circular.
    const r: Infer<typeof created> = await ctx.runMutation(internal.inviteLinks.createForUser, { userId, name, linkHash: sha256Hex(token) })
    if (!r.ok) return r
    return { ok: true as const, inviteId: r.inviteId, url: inviteUrl(token), expiresAt: r.expiresAt }
  },
})

export const createForUser = internalMutation({
  args: { userId: v.id("users"), name: v.string(), linkHash: v.string() },
  returns: created,
  handler: async (ctx, { userId, name, linkHash }) => {
    if (!(await memberOf(ctx, userId))) return { ok: false as const, error: "not-member" as const }
    return await createNetworkInvite(ctx, userId, name, linkHash, Date.now())
  },
})

/** The caller's invite links nobody has used yet. */
export const mine = query({
  args: {},
  returns: v.union(v.null(), v.array(inviteRow)),
  handler: async (ctx) => {
    const m = await networkMember(ctx)
    return m ? await openInvites(ctx, m.userId, Date.now()) : null
  },
})

/** Takes back one of the caller's unused links. */
export const revoke = mutation({
  args: { inviteId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { inviteId }) => {
    const m = await networkMember(ctx)
    return m ? await revokeInvite(ctx, m.userId, inviteId) : false
  },
})

// ---- Device API ----

/** POST /device/invites */
export const createForDevice = internalMutation({
  args: { tokenHash: v.string(), name: v.string(), linkHash: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(false), error: v.literal("unauthorized") }),
    created,
  ),
  handler: async (ctx, { tokenHash, name, linkHash }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return { ok: false as const, error: "unauthorized" as const }
    return await createNetworkInvite(ctx, auth.user._id, name, linkHash, Date.now())
  },
})

/** GET /device/invites */
export const listForDevice = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(v.null(), v.array(inviteRow)),
  handler: async (ctx, { tokenHash }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    return auth ? await openInvites(ctx, auth.user._id, Date.now()) : null
  },
})

/** POST /device/invites/revoke */
export const revokeForDevice = internalMutation({
  args: { tokenHash: v.string(), inviteId: v.string() },
  returns: v.union(v.null(), v.boolean()),
  handler: async (ctx, { tokenHash, inviteId }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    return auth ? await revokeInvite(ctx, auth.user._id, inviteId) : null
  },
})
