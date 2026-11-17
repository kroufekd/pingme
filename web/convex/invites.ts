import { v } from "convex/values"
import { internal } from "./_generated/api"
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import { sendEmail } from "./ResendOTP"
import { normalizeEmail } from "./model"
import { isOwnerEmail } from "./network"

async function findInvite(ctx: QueryCtx, email: string) {
  return await ctx.db
    .query("invites")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .unique()
}

/** The owner (env OWNER_EMAIL) may always sign in, so the network can start from nothing. */
async function allowed(ctx: QueryCtx, email: string) {
  return isOwnerEmail(email) || (await findInvite(ctx, email)) !== null
}

/** Lets the sign-in form say "no invite for this email" before sending a code. */
export const check = query({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { email }) => await allowed(ctx, email),
})

export const isInvited = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<boolean> => await allowed(ctx, email),
})

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("invites").collect()
    return all.map((i) => ({ email: i.email, name: i.name, createdAt: i.createdAt }))
  },
})

export const add = internalMutation({
  args: { email: v.string(), name: v.string() },
  handler: async (ctx, { email, name }) => {
    const normalized = normalizeEmail(email)
    const existing = await findInvite(ctx, normalized)
    if (existing) {
      await ctx.db.patch(existing._id, { name })
      return { created: false }
    }
    await ctx.db.insert("invites", { email: normalized, name, createdAt: Date.now() })
    return { created: true }
  },
})

/** Adds the email to the allowlist and sends the invitation email. */
export const send = internalAction({
  args: { email: v.string(), name: v.string() },
  handler: async (ctx, { email, name }): Promise<{ ok: boolean; status: number }> => {
    await ctx.runMutation(internal.invites.add, { email, name })
    // WEB_URL = the published web app (SITE_URL points at the API host).
    const site = process.env.WEB_URL ?? process.env.SITE_URL ?? ""
    const message = [
      `Hi ${name},`,
      "",
      "Dominik invited you to pingme. A ping you send there pops up on his Mac and stays until he clears it.",
      "",
      `1. Open ${site}`,
      `2. Enter this email: ${normalizeEmail(email)}`,
      "3. You get a code. Type it in and you are in.",
      "",
      "Tip: on your phone, add the page to your home screen (in Safari: Share, Add to Home Screen) to keep it at hand like an app.",
    ].join("\n")
    const response = await sendEmail({
      toEmail: normalizeEmail(email),
      subject: "Dominik invited you to pingme",
      message,
    })
    return { ok: response.ok, status: response.status }
  },
})
