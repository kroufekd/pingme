import { v } from "convex/values"
import { query } from "./_generated/server"
import { isMacKey, lastSeen, toQueued } from "./model"
import { queuedCommand } from "./validators"

/**
 * Live feed for the Mac (a Convex subscription with MAC_TOKEN as `key`).
 * Reads only the queue and the web heartbeat, so it reruns only when a command
 * arrives or leaves or when the web pings. No clock here: cached queries do not
 * rerun on time, the Mac decides "watching" itself from `webLastSeen`.
 */
export const get = query({
  args: { key: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(false) }),
    v.object({
      ok: v.literal(true),
      commands: v.array(queuedCommand),
      webLastSeen: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, { key }) => {
    if (!isMacKey(key)) return { ok: false as const }
    const commands = await ctx.db.query("commands").order("asc").take(50)
    return { ok: true as const, commands: commands.map(toQueued), webLastSeen: await lastSeen(ctx, "web") }
  },
})
