import { getAuthUserId } from "@convex-dev/auth/server"
import { v } from "convex/values"
import { internalQuery, query } from "./_generated/server"
import { contactsView, deviceForToken, memberOf } from "./network"
import { contactInfo, myDevice } from "./validators"

const me = v.object({ userId: v.string(), name: v.string(), devices: v.array(myDevice) })

/**
 * The caller's contacts with their devices (to encrypt to) and the caller's own devices
 * (for the sender's copy). `online` is as of this query run; cached queries do not rerun on
 * time, so the web derives the dot from `macLastSeen` on its own timer.
 */
export const list = query({
  args: {},
  returns: v.union(
    v.object({ status: v.literal("signedOut") }),
    v.object({ status: v.literal("notMember") }),
    v.object({ status: v.literal("member"), me, contacts: v.array(contactInfo) }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx)
    if (!userId) return { status: "signedOut" as const }
    const user = await memberOf(ctx, userId)
    if (!user) return { status: "notMember" as const }
    return { status: "member" as const, ...(await contactsView(ctx, user, Date.now())) }
  },
})

/** GET /device/contacts */
export const forDevice = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({ ok: v.literal(true), now: v.number(), me, contacts: v.array(contactInfo) }),
  ),
  handler: async (ctx, { tokenHash }) => {
    const auth = await deviceForToken(ctx, tokenHash)
    if (!auth) return { ok: false as const }
    const now = Date.now()
    return { ok: true as const, now, ...(await contactsView(ctx, auth.user, now)) }
  },
})
