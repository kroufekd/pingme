import { httpRouter } from "convex/server"
import { internal } from "./_generated/api"
import { httpAction } from "./_generated/server"
import { auth } from "./auth"
import { addDeviceRoutes } from "./deviceApi"
import { handleMcp } from "./mcp"
import { INVITE_TTL, MAX_NAME, MAX_REPLY, MAX_TITLE, isMacKey, sha256Hex } from "./model"
import type { SnapTask, StatusUpdate, TaskState } from "./validators"

const http = httpRouter()

auth.addHttpRoutes(http)

// ---- Mac app API (Authorization: Bearer MAC_TOKEN) ----

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

function authorized(req: Request) {
  const header = req.headers.get("Authorization") ?? ""
  return header.startsWith("Bearer ") && isMacKey(header.slice("Bearer ".length))
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json()
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (x: unknown) => (typeof x === "string" ? x : undefined)
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined)
const unauthorized = () => json({ error: "unauthorized" }, 401)

const SOURCES = new Set(["web", "mac", "followup"])
const REPEATS = new Set(["daily", "weekdays", "weekly", "biweekly", "monthly"])
const KINDS = new Set(["person", "agent"])
const URGENCIES = new Set(["green", "orange", "red"])
const STATES = new Set(["queued", "waiting", "popped", "seen", "replied", "done", "snoozed"])
const ref = (x: unknown) => {
  const s = str(x)
  return s && s.length <= 100 ? s : undefined
}
const positive = (x: unknown) => {
  const n = num(x)
  return n !== undefined && n > 0 ? n : undefined
}

/** Keeps only well-formed tasks from the Mac, trimmed to sane sizes. */
function cleanTask(x: unknown): SnapTask | null {
  if (!x || typeof x !== "object") return null
  const o = x as Record<string, unknown>
  const id = str(o.id)
  const title = str(o.title)?.trim().slice(0, MAX_TITLE)
  const dueAt = num(o.dueAt)
  const showAt = num(o.showAt)
  const source = str(o.source)
  if (!id || id.length > 100 || !title || dueAt === undefined || showAt === undefined) return null
  if (!source || !SOURCES.has(source)) return null
  const task: SnapTask = {
    id,
    title,
    dueAt,
    showAt,
    byName: str(o.byName)?.slice(0, 60) || "Mac",
    source: source as SnapTask["source"],
    snoozeCount: Math.max(0, Math.round(num(o.snoozeCount) ?? 0)),
  }
  const doneAt = num(o.doneAt)
  if (doneAt !== undefined) task.doneAt = doneAt
  const followUpTitle = str(o.followUpTitle)?.trim().slice(0, MAX_TITLE)
  const followUpMinutes = num(o.followUpMinutes)
  if (followUpTitle && followUpMinutes !== undefined) {
    task.followUpTitle = followUpTitle
    task.followUpMinutes = followUpMinutes
  }
  const followsFrom = str(o.followsFrom)?.slice(0, MAX_TITLE)
  if (followsFrom) task.followsFrom = followsFrom
  const rep = str(o.repeat)
  if (rep && REPEATS.has(rep)) task.repeat = rep as SnapTask["repeat"]
  // v2 fields. Unknown values are dropped, never rejected, so one odd task cannot block the sync.
  const senderId = ref(o.senderId)
  if (senderId) task.senderId = senderId
  const kind = str(o.senderKind)
  if (kind && KINDS.has(kind)) task.senderKind = kind as SnapTask["senderKind"]
  const urgency = str(o.urgency)
  if (urgency && URGENCIES.has(urgency)) task.urgency = urgency as SnapTask["urgency"]
  if (o.to === "agent") task.to = "agent"
  const taskRef = ref(o.taskRef)
  if (taskRef) task.taskRef = taskRef
  const reply = str(o.reply)?.trim().slice(0, MAX_REPLY)
  if (reply) task.reply = reply
  const replyAt = positive(o.replyAt)
  if (reply && replyAt !== undefined) task.replyAt = replyAt
  const seenAt = positive(o.seenAt)
  if (seenAt !== undefined) task.seenAt = seenAt
  const snoozedUntil = positive(o.snoozedUntil)
  if (snoozedUntil !== undefined) task.snoozedUntil = snoozedUntil
  return task
}

/** One status from the Mac's outbox. Malformed ones are skipped, not rejected. */
function cleanStatus(x: unknown): StatusUpdate | null {
  if (!x || typeof x !== "object") return null
  const o = x as Record<string, unknown>
  const taskRef = ref(o.taskRef)
  const status = str(o.status)
  const at = positive(o.at)
  if (!taskRef || !status || !STATES.has(status) || at === undefined) return null
  const update: StatusUpdate = { taskRef, status: status as TaskState, at }
  const snoozedUntil = positive(o.snoozedUntil)
  if (status === "snoozed" && snoozedUntil !== undefined) update.snoozedUntil = snoozedUntil
  const reply = str(o.reply)?.trim().slice(0, MAX_REPLY)
  if (reply) update.reply = reply
  return update
}

http.route({
  path: "/mac/sync",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    const body = await readBody(req)
    if (!body) return json({ error: "bad-request" }, 400)
    const ack = Array.isArray(body.ack)
      ? body.ack.filter((x): x is string => typeof x === "string").slice(0, 200)
      : []
    const tasks = Array.isArray(body.tasks)
      ? body.tasks.slice(0, 300).map(cleanTask).filter((t): t is SnapTask => t !== null)
      : undefined
    const statuses = Array.isArray(body.statuses)
      ? body.statuses.slice(0, 100).map(cleanStatus).filter((s): s is StatusUpdate => s !== null)
      : undefined
    const typingBody = body.typing && typeof body.typing === "object" ? (body.typing as Record<string, unknown>) : null
    const typing = typingBody ? ref(typingBody.taskRef) : undefined
    return json(await ctx.runMutation(internal.mac.sync, { ack, tasks, statuses, typing }))
  }),
})

// Routes of the first Mac app version. Tasks now live on the Mac, use /mac/sync.
const gone = httpAction(async () => json({ error: "gone", use: "/mac/sync" }, 410))
http.route({ path: "/mac/state", method: "GET", handler: gone })
for (const path of ["/mac/tasks", "/mac/done", "/mac/snooze", "/mac/delete"]) {
  http.route({ path, method: "POST", handler: gone })
}

http.route({
  path: "/mac/invite",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    const body = await readBody(req)
    const email = str(body?.email)?.trim()
    const name = str(body?.name)?.trim() || "Viki"
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || name.length > 60) {
      return json({ error: "bad-email" }, 400)
    }
    const result = await ctx.runAction(internal.invites.send, { email, name })
    return json(result, result.ok ? 200 : 502)
  }),
})

http.route({
  path: "/mac/invites",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    return json(await ctx.runQuery(internal.invites.list, {}))
  }),
})

// ---- People and agents (v2) ----

function base64url(bytes: Uint8Array) {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const DEFAULT_WEB_URL = "https://pingme.macaly.app"

/** Owner invites a person by name. The link works once, for 7 days. */
http.route({
  path: "/mac/invite-link",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    const body = await readBody(req)
    const name = str(body?.name)?.trim()
    if (!name || name.length > MAX_NAME) return json({ error: "bad-name" }, 400)
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const token = base64url(bytes)
    const now = Date.now()
    const expiresAt = now + INVITE_TTL
    const senderId = await ctx.runMutation(internal.senders.createInvite, {
      name,
      tokenHash: sha256Hex(token),
      now,
      expiresAt,
    })
    const web = (process.env.WEB_URL || DEFAULT_WEB_URL).replace(/\/+$/, "")
    return json({ senderId, url: `${web}/?i=${token}`, expiresAt })
  }),
})

/** Owner registers an agent key. The Mac made the key; only its SHA-256 comes here. */
http.route({
  path: "/mac/agent-key",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    const body = await readBody(req)
    const name = str(body?.name)?.trim()
    const keyHash = str(body?.keyHash)?.trim().toLowerCase()
    const keyTail = str(body?.keyTail)?.trim()
    if (!name || name.length > MAX_NAME) return json({ error: "bad-name" }, 400)
    if (!keyHash || !/^[0-9a-f]{64}$/.test(keyHash)) return json({ error: "bad-key-hash" }, 400)
    if (!keyTail || keyTail.length > 8) return json({ error: "bad-key-tail" }, 400)
    const result = await ctx.runMutation(internal.senders.createAgent, { name, keyHash, keyTail })
    if (!result.ok) return json({ error: "duplicate" }, 409)
    return json({ senderId: result.senderId })
  }),
})

http.route({
  path: "/mac/senders",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    return json({ senders: await ctx.runQuery(internal.senders.list, {}) })
  }),
})

/** Owner removes a person, an invitation or an agent. */
http.route({
  path: "/mac/sender-revoke",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    if (!authorized(req)) return unauthorized()
    const body = await readBody(req)
    const senderId = str(body?.senderId)
    if (!senderId || senderId.length > 100) return json({ error: "bad-request" }, 400)
    const result = await ctx.runMutation(internal.senders.revoke, { senderId })
    return result.ok ? json({ ok: true }) : json({ ok: false, error: "not-found" }, 404)
  }),
})

// ---- Network devices (Authorization: Device <token>), see docs/device-api.md ----

addDeviceRoutes(http)

// ---- MCP for agents (Authorization: Bearer <agent key>) ----

http.route({
  path: "/mcp",
  method: "POST",
  handler: httpAction(async (ctx, req) => await handleMcp(ctx, req)),
})

const mcpOnlyPost = httpAction(async () =>
  new Response(JSON.stringify({ error: "method-not-allowed" }), {
    status: 405,
    headers: { "Content-Type": "application/json", Allow: "POST" },
  }),
)
for (const method of ["GET", "PUT", "DELETE", "PATCH", "OPTIONS"] as const) {
  http.route({ path: "/mcp", method, handler: mcpOnlyPost })
}

export default http
