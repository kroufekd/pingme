import { v } from "convex/values"
import type { Infer } from "convex/values"
import { mutation } from "./_generated/server"

// v1 had one shared PIN (env APP_PIN) instead of email codes. It gave everyone the same view,
// which breaks the isolation between senders, so it is closed for good in code: `login` always
// answers "not-set" and any PIN token is signed out (see currentMember in model.ts).
// The signatures stay because the deployed contract only grows.

const loginResult = v.union(
  v.object({ ok: v.literal(true), token: v.string() }),
  v.object({
    ok: v.literal(false),
    error: v.union(v.literal("wrong"), v.literal("locked"), v.literal("bad-name"), v.literal("not-set")),
    retryAt: v.optional(v.number()),
  }),
)

export const login = mutation({
  args: { pin: v.string(), name: v.string() },
  returns: loginResult,
  // Typed as the full v1 result so existing callers keep compiling.
  handler: async (): Promise<Infer<typeof loginResult>> => ({ ok: false, error: "not-set" }),
})

export const logout = mutation({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    const s = await ctx.db
      .query("pinSessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique()
    if (s) await ctx.db.delete(s._id)
    return null
  },
})
