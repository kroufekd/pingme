import { v } from "convex/values"
import { internal } from "./_generated/api"
import { internalMutation, internalQuery } from "./_generated/server"
import type { ActionCtx, QueryCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { HOUR, MAX_TITLE, MINUTE, activeAgentForKeyHash, createTask, ownStatus, sha256Hex } from "./model"
import { createLegacyMessage, ownerWithMac } from "./network"
import { taskState, urgency } from "./validators"
import type { Urgency } from "./validators"

// MCP for agents: stateless Streamable HTTP on POST /mcp, one JSON-RPC request in, one JSON answer out.
// Auth: Authorization: Bearer <agent key>. Only the SHA-256 of the key is stored.

const RATE_LIMIT = 30
const NOT_FOUND = "not found"

async function activeAgent(ctx: QueryCtx, senderId: Id<"senders">) {
  const s = await ctx.db.get(senderId)
  return s && s.kind === "agent" && s.status === "active" ? s : null
}

export const agent = internalQuery({
  args: { keyHash: v.string() },
  returns: v.union(v.null(), v.object({ senderId: v.id("senders") })),
  handler: async (ctx, { keyHash }) => {
    const s = await activeAgentForKeyHash(ctx, keyHash)
    return s ? { senderId: s._id } : null
  },
})

const failure = v.object({ ok: v.literal(false), error: v.string() })

/**
 * Queues a task from an agent, like relay.create. 30 per hour per key.
 * Once the owner (env OWNER_EMAIL) has a paired Mac, it goes there as an unencrypted message;
 * until then it stays on the v2 queue the installed Mac app reads.
 */
export const sendMessage = internalMutation({
  args: { senderId: v.id("senders"), title: v.string(), urgency },
  returns: v.union(v.object({ ok: v.literal(true), id: v.string() }), failure),
  handler: async (ctx, args) => {
    const sender = await activeAgent(ctx, args.senderId)
    if (!sender) return { ok: false as const, error: "unauthorized" }
    const title = args.title.trim()
    if (!title || title.length > MAX_TITLE) return { ok: false as const, error: "bad-title" }
    const now = Date.now()
    const fresh = sender.rateWindowStart === undefined || now - sender.rateWindowStart >= HOUR
    const count = fresh ? 0 : (sender.rateCount ?? 0)
    if (count >= RATE_LIMIT) return { ok: false as const, error: "rate-limited" }
    const owner = await ownerWithMac(ctx)
    const id = owner
      ? await createLegacyMessage(ctx, sender, owner._id, title, args.urgency, now)
      : await createTask(ctx, sender, { title, dueAt: now, urgency: args.urgency }, now)
    const stale = sender.lastUsedAt === undefined || now - sender.lastUsedAt >= MINUTE
    await ctx.db.patch(sender._id, {
      rateWindowStart: fresh ? now : sender.rateWindowStart,
      rateCount: count + 1,
      ...(stale ? { lastUsedAt: now } : {}),
    })
    return { ok: true as const, id }
  },
})

/** Pure read: agents poll this. */
export const getStatus = internalQuery({
  args: { senderId: v.id("senders"), id: v.string() },
  returns: v.union(
    v.object({
      ok: v.literal(true),
      status: taskState,
      at: v.number(),
      snoozedUntil: v.union(v.number(), v.null()),
      typing: v.boolean(),
    }),
    failure,
  ),
  handler: async (ctx, { senderId, id }) => {
    if (!(await activeAgent(ctx, senderId))) return { ok: false as const, error: "unauthorized" }
    const st = await ownStatus(ctx, senderId, id)
    if (!st) return { ok: false as const, error: NOT_FOUND }
    return {
      ok: true as const,
      status: st.status,
      at: st.at,
      snoozedUntil: st.status === "snoozed" ? (st.snoozedUntil ?? null) : null,
      typing: st.typingUntil !== undefined && st.typingUntil > Date.now(),
    }
  },
})

/** Returns the reply once and deletes it. Writes only when there is a reply. */
export const getReply = internalMutation({
  args: { senderId: v.id("senders"), id: v.string() },
  returns: v.union(
    v.object({ ok: v.literal(true), reply: v.union(v.string(), v.null()), at: v.optional(v.number()) }),
    failure,
  ),
  handler: async (ctx, { senderId, id }) => {
    if (!(await activeAgent(ctx, senderId))) return { ok: false as const, error: "unauthorized" }
    const st = await ownStatus(ctx, senderId, id)
    if (!st) return { ok: false as const, error: NOT_FOUND }
    if (st.reply === undefined) return { ok: true as const, reply: null }
    await ctx.db.patch(st._id, { reply: undefined, replyAt: undefined })
    return { ok: true as const, reply: st.reply, at: st.replyAt ?? st.at }
  },
})

// ---- JSON-RPC over HTTP ----

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"]
const URGENCIES = ["green", "orange", "red"]

const idInput = {
  type: "object",
  properties: { id: { type: "string", description: "The id that pingme returned." } },
  required: ["id"],
  additionalProperties: false,
}

const TOOLS = [
  {
    name: "pingme",
    description:
      "Ping Dominik: send him a task or a heads-up. It pops up on his Mac and stays there until he handles it. Returns an id for get_status and get_reply.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: MAX_TITLE,
          description: "What Dominik should do, in one short sentence.",
        },
        urgency: {
          type: "string",
          enum: URGENCIES,
          default: "green",
          description:
            "green = can wait (silent), orange = soon (sound, reminder after 2 minutes), red = now (sound, reminder every minute). Use red only when it cannot wait.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description:
      "Live state of a task you sent: queued, waiting, popped, seen, replied, done or snoozed. typing is true while Dominik is writing a reply.",
    inputSchema: idInput,
  },
  {
    name: "get_reply",
    description:
      "Dominik's reply to a task you sent, or null when there is none yet. Reading it deletes it on the server, so keep it.",
    inputSchema: idInput,
  },
]

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

type RpcId = string | number | null

const rpcResult = (id: RpcId, result: unknown) => json({ jsonrpc: "2.0", id, result })
const rpcError = (id: RpcId, code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status)
const unauthorized = () => json({ error: "unauthorized" }, 401)

function toolResult(result: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    ...(isError ? { isError: true } : {}),
  }
}

type ToolOutcome = { unauthorized: true } | { result: ReturnType<typeof toolResult> }

async function callTool(
  ctx: ActionCtx,
  senderId: Id<"senders">,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const fail = (error: string): ToolOutcome =>
    error === "unauthorized" ? { unauthorized: true } : { result: toolResult({ error }, true) }

  // "send_message" was the first name of this tool, still accepted.
  if (name === "pingme" || name === "send_message") {
    if (typeof args.title !== "string") return fail("bad-title")
    const level = args.urgency ?? "green"
    if (typeof level !== "string" || !URGENCIES.includes(level)) return fail("bad-urgency")
    const r = await ctx.runMutation(internal.mcp.sendMessage, {
      senderId,
      title: args.title,
      urgency: level as Urgency,
    })
    return r.ok ? { result: toolResult({ id: r.id, status: "queued" }) } : fail(r.error)
  }

  // Unknown, malformed and foreign ids all get the same answer.
  const id = typeof args.id === "string" ? args.id : ""
  if (name === "get_status") {
    const r = await ctx.runQuery(internal.mcp.getStatus, { senderId, id })
    if (!r.ok) return fail(r.error)
    return {
      result: toolResult({ status: r.status, at: r.at, snoozed_until: r.snoozedUntil, typing: r.typing }),
    }
  }
  const r = await ctx.runMutation(internal.mcp.getReply, { senderId, id })
  if (!r.ok) return fail(r.error)
  return { result: toolResult(r.reply === null ? { reply: null } : { reply: r.reply, at: r.at }) }
}

/**
 * Handles one POST /mcp. HTTP status codes: 401 bad key, 202 for notifications and client
 * responses, 400 for parse errors (-32700), batches and invalid requests (-32600),
 * 200 for every answer to a valid request, including -32601 and -32602.
 */
export async function handleMcp(ctx: ActionCtx, req: Request): Promise<Response> {
  const header = (req.headers.get("Authorization") ?? "").trim()
  const bearer = /^Bearer\s+(\S{1,200})$/i.exec(header)
  const found = bearer ? await ctx.runQuery(internal.mcp.agent, { keyHash: sha256Hex(bearer[1]) }) : null
  if (!found) return unauthorized()

  let msg: unknown
  try {
    msg = JSON.parse(await req.text())
  } catch {
    return rpcError(null, -32700, "Parse error", 400)
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "Batch requests are not supported", 400)
  if (!msg || typeof msg !== "object") return rpcError(null, -32600, "Invalid Request", 400)
  const o = msg as Record<string, unknown>
  if (typeof o.method !== "string") {
    // A response to something we never asked: accept and ignore.
    if ("result" in o || "error" in o) return new Response(null, { status: 202 })
    return rpcError(null, -32600, "Invalid Request", 400)
  }
  if (!("id" in o)) return new Response(null, { status: 202 })
  const id = o.id
  if (typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Invalid Request", 400)
  const params = o.params && typeof o.params === "object" ? (o.params as Record<string, unknown>) : {}

  switch (o.method) {
    case "initialize": {
      const asked = params.protocolVersion
      return rpcResult(id, {
        protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "pingme", version: "2.0.0" },
        instructions: "Use pingme to send Dominik a task that pops up on his Mac. Use urgency red only when it cannot wait.",
      })
    }
    case "ping":
      return rpcResult(id, {})
    case "tools/list":
      return rpcResult(id, { tools: TOOLS })
    case "tools/call": {
      const name = params.name
      if (typeof name !== "string" || !(name === "send_message" || TOOLS.some((t) => t.name === name))) {
        return rpcError(id, -32602, `Unknown tool: ${typeof name === "string" ? name.slice(0, 60) : ""}`)
      }
      const args =
        params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {}
      const outcome = await callTool(ctx, found.senderId, name, args)
      if ("unauthorized" in outcome) return unauthorized()
      return rpcResult(id, outcome.result)
    }
    default:
      return rpcError(id, -32601, "Method not found")
  }
}
