import type { HttpRouter } from "convex/server"
import { internal } from "./_generated/api"
import { httpAction } from "./_generated/server"
import type { ActionCtx } from "./_generated/server"
import { sha256Hex } from "./model"
import { MAX_ENVELOPES, RE_ANY_REF, RE_TOKEN, inviteUrl, randomToken } from "./network"
import type { DeviceStatus, EnvelopeIn, TaskState } from "./validators"
// The same HPKE code the web uses (pure JS X25519 and ChaCha20, WebCrypto HKDF).
import { PAIR_INFO, pairTokenAad, sealWithInfo } from "../src/lib/seal"

const PAIR_INFO_BYTES = new TextEncoder().encode(PAIR_INFO)

// HTTP API for the Mac app: /device/*, "Authorization: Device <token>".
// Every call re-checks the token inside its own transaction, so a revoked device is out at once.
// The exact JSON shapes are in docs/device-api.md.

const MAX_BODY = 64 * 1024

/** HTTP status for each error code. The body is always { ok: false, error, ...details }. */
const STATUS: Record<string, number> = {
  unauthorized: 401,
  "bad-request": 400,
  "bad-ref": 400,
  "bad-urgency": 400,
  "bad-repeat": 400,
  "bad-time": 400,
  "bad-agent": 400,
  "bad-envelope": 400,
  "bad-text": 400,
  "bad-name": 400,
  "not-contact": 403,
  "not-member": 403,
  "not-found": 404,
  "ref-taken": 409,
  "no-device": 409,
  "stale-devices": 409,
  "pair-exists": 409,
  "too-large": 413,
  "too-many-invites": 429,
  "rate-limited": 429,
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  })
}

function failure(result: { error: string } & Record<string, unknown>) {
  return json({ ...result, ok: false }, STATUS[result.error] ?? 400)
}

const bad = () => failure({ error: "bad-request" })
const unauthorized = () => failure({ error: "unauthorized" })

/** SHA-256 of the device token from "Authorization: Device <token>", or null. */
function tokenHash(req: Request) {
  const m = /^Device ([A-Za-z0-9_-]+)$/.exec((req.headers.get("Authorization") ?? "").trim())
  return m && RE_TOKEN.test(m[1]) ? sha256Hex(m[1]) : null
}

type Body = Record<string, unknown>

/** The JSON object body, null when malformed, "too-large" over 64 KB. */
async function readBody(req: Request): Promise<Body | null | "too-large"> {
  if (Number(req.headers.get("Content-Length") ?? "0") > MAX_BODY) return "too-large"
  const text = await req.text()
  if (text.length > MAX_BODY) return "too-large"
  if (!text.trim()) return {}
  try {
    const body: unknown = JSON.parse(text)
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : null
  } catch {
    return null
  }
}

const str = (x: unknown) => (typeof x === "string" ? x : undefined)
const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined)

/** Envelopes with the right field types (formats are checked in the mutation). */
function envelopes(x: unknown): EnvelopeIn[] | null {
  if (!Array.isArray(x) || x.length > MAX_ENVELOPES) return null
  const out: EnvelopeIn[] = []
  for (const e of x) {
    if (!e || typeof e !== "object") return null
    const o = e as Body
    const deviceId = str(o.deviceId)
    const enc = str(o.enc)
    const ct = str(o.ct)
    if (!deviceId || deviceId.length > 64 || !enc || enc.length > 64 || !ct || ct.length > 2048) return null
    out.push({ deviceId, enc, ct })
  }
  return out
}

function refs(x: unknown, max: number): string[] | null {
  if (x === undefined) return []
  if (!Array.isArray(x) || x.length > max) return null
  return x.filter((r): r is string => typeof r === "string" && RE_ANY_REF.test(r))
}

const STATES = new Set(["waiting", "popped", "seen", "done", "snoozed"])

/** One status from the Mac's outbox. Malformed ones are skipped, never fail the sync. */
function status(x: unknown): DeviceStatus | null {
  if (!x || typeof x !== "object") return null
  const o = x as Body
  const ref = str(o.ref)
  const state = str(o.status)
  const at = num(o.at)
  if (!ref || !RE_ANY_REF.test(ref) || !state || !STATES.has(state) || at === undefined || at <= 0) return null
  const s: DeviceStatus = { ref, status: state as TaskState, at }
  const until = num(o.snoozedUntil)
  if (state === "snoozed" && until !== undefined && until > 0) s.snoozedUntil = until
  return s
}

type Handler = (ctx: ActionCtx, req: Request, body: Body) => Promise<Response>

/** Parses the body (POST) and passes it on. */
function route(http: HttpRouter, method: "GET" | "POST", path: string, handler: Handler) {
  http.route({
    path,
    method,
    handler: httpAction(async (ctx, req) => {
      const body = method === "POST" ? await readBody(req) : {}
      if (body === "too-large") return failure({ error: "too-large" })
      if (body === null) return bad()
      return await handler(ctx, req, body)
    }),
  })
}

/** Same as route, with the device token checked first: no valid token, 401 before anything else. */
function authed(
  http: HttpRouter,
  method: "GET" | "POST",
  path: string,
  handler: (ctx: ActionCtx, hash: string, body: Body) => Promise<Response>,
) {
  http.route({
    path,
    method,
    handler: httpAction(async (ctx, req) => {
      const hash = tokenHash(req)
      if (!hash) return unauthorized()
      const body = method === "POST" ? await readBody(req) : {}
      if (body === "too-large") return failure({ error: "too-large" })
      if (body === null) return bad()
      return await handler(ctx, hash, body)
    }),
  })
}

/** ok results as 200, errors with their status. */
function reply(result: { ok: boolean } & Record<string, unknown>) {
  return result.ok ? json(result) : failure(result as unknown as { error: string })
}

export function addDeviceRoutes(http: HttpRouter) {
  // ---- Pairing (no token yet) ----

  route(http, "POST", "/device/pair/start", async (ctx, _req, body) => {
    const pairId = str(body.pairId)
    const secretHash = str(body.secretHash)
    const publicKey = str(body.publicKey)
    const name = str(body.name)
    if (!pairId || !secretHash || !publicKey || !name || name.length > 200) return bad()
    return reply(await ctx.runMutation(internal.devices.pairStart, { pairId, secretHash, publicKey, name }))
  })

  route(http, "POST", "/device/pair/claim", async (ctx, _req, body) => {
    const pairId = str(body.pairId)
    const secret = str(body.secret)
    if (!pairId || !secret || !RE_TOKEN.test(secret)) return bad()
    const secretHash = sha256Hex(secret)
    let r = await ctx.runMutation(internal.devices.pairClaim, { pairId, secretHash })
    if (r.status === "seal") {
      // Minted here (an action) so queries and mutations never make secrets, and sealed to the
      // key the Mac registered: the plaintext token never leaves this function.
      const token = randomToken()
      const sealedToken = await sealWithInfo(PAIR_INFO_BYTES, r.publicKey, token, pairTokenAad(pairId, r.userId))
      r = await ctx.runMutation(internal.devices.pairFinish, {
        pairId,
        secretHash,
        userId: r.userId,
        tokenHash: sha256Hex(token),
        sealedToken,
      })
    }
    if (r.status === "pending") return json({ ok: true, status: "pending" }, 202)
    if (r.status === "rate-limited") return failure({ error: "rate-limited" })
    if (r.status !== "approved") return failure({ error: "not-found" })
    return json({ ok: true, status: "approved", sealedToken: r.sealedToken, deviceId: r.deviceId, userId: r.userId, name: r.name })
  })

  // ---- The device ----

  authed(http, "GET", "/device/me", async (ctx, hash) => {
    const r = await ctx.runQuery(internal.devices.whoami, { tokenHash: hash })
    return r.ok ? json(r) : unauthorized()
  })

  authed(http, "POST", "/device/unpair", async (ctx, hash) => {
    return (await ctx.runMutation(internal.devices.unpair, { tokenHash: hash })) ? json({ ok: true }) : unauthorized()
  })

  // The person's own devices are listed in GET /device/contacts (me.devices).
  authed(http, "POST", "/device/devices/revoke", async (ctx, hash, body) => {
    const deviceId = str(body.deviceId)
    if (!deviceId || deviceId.length > 64) return bad()
    const r = await ctx.runMutation(internal.devices.revokeForDevice, { tokenHash: hash, deviceId })
    if (r === null) return unauthorized()
    return r ? json({ ok: true }) : failure({ error: "not-found" })
  })

  authed(http, "POST", "/device/sync", async (ctx, hash, body) => {
    const ack = refs(body.ack, 100)
    if (!ack || (body.statuses !== undefined && !Array.isArray(body.statuses))) return bad()
    const statuses = ((body.statuses as unknown[] | undefined) ?? [])
      .slice(0, 100)
      .map(status)
      .filter((s): s is DeviceStatus => s !== null)
    const typing = str(body.typing)
    return reply(
      await ctx.runMutation(internal.messages.deviceSync, {
        tokenHash: hash,
        ack,
        statuses,
        typing: typing && RE_ANY_REF.test(typing) ? typing : undefined,
      }),
    )
  })

  authed(http, "POST", "/device/reply", async (ctx, hash, body) => {
    const ref = str(body.ref)
    const at = num(body.at)
    const text = str(body.text)
    const env = body.envelopes === undefined ? undefined : envelopes(body.envelopes)
    if (!ref || at === undefined || env === null || (env === undefined) === (text === undefined)) return bad()
    if (text !== undefined && text.length > 1000) return failure({ error: "bad-text" })
    return reply(await ctx.runMutation(internal.messages.deviceReply, { tokenHash: hash, ref, at, envelopes: env, text }))
  })

  authed(http, "GET", "/device/contacts", async (ctx, hash) => {
    const r = await ctx.runQuery(internal.contacts.forDevice, { tokenHash: hash })
    return r.ok ? json(r) : unauthorized()
  })

  authed(http, "POST", "/device/send", async (ctx, hash, body) => {
    const ref = str(body.ref)
    const to = str(body.to)
    if (body.urgency !== undefined && typeof body.urgency !== "string") return bad()
    const urgency = str(body.urgency) ?? "green"
    const forAgent = body.forAgent === undefined ? false : body.forAgent
    const env = envelopes(body.envelopes)
    const title = envelopes(body.titleEnvelopes ?? [])
    const dueAt = body.dueAt === undefined || body.dueAt === null ? undefined : num(body.dueAt)
    const repeat = body.repeat === undefined || body.repeat === null ? undefined : str(body.repeat)
    const fromAgent = body.fromAgent === undefined || body.fromAgent === null ? undefined : str(body.fromAgent)
    if (!ref || !to || to.length > 64 || typeof forAgent !== "boolean" || !env || !title) return bad()
    if ((body.dueAt != null && dueAt === undefined) || (body.repeat != null && repeat === undefined)) return bad()
    if (body.fromAgent != null && (fromAgent === undefined || fromAgent.length > 200)) return bad()
    return reply(
      await ctx.runMutation(internal.messages.deviceSend, {
        tokenHash: hash,
        ref,
        to,
        forAgent,
        urgency,
        dueAt,
        repeat,
        fromAgent,
        envelopes: env,
        titleEnvelopes: title,
      }),
    )
  })

  authed(http, "POST", "/device/sent", async (ctx, hash, body) => {
    const list = body.refs === undefined ? undefined : refs(body.refs, 50)
    if (list === null) return bad()
    return reply(await ctx.runQuery(internal.messages.deviceSent, { tokenHash: hash, refs: list }))
  })

  // ---- Invites ----

  authed(http, "POST", "/device/invites", async (ctx, hash, body) => {
    const name = str(body.name)
    if (!name || name.length > 200) return failure({ error: "bad-name" })
    const token = randomToken()
    const r = await ctx.runMutation(internal.inviteLinks.createForDevice, { tokenHash: hash, name, linkHash: sha256Hex(token) })
    if (!r.ok) return failure(r)
    return json({ ok: true, inviteId: r.inviteId, url: inviteUrl(token), expiresAt: r.expiresAt })
  })

  authed(http, "GET", "/device/invites", async (ctx, hash) => {
    const invites = await ctx.runQuery(internal.inviteLinks.listForDevice, { tokenHash: hash })
    return invites ? json({ ok: true, invites }) : unauthorized()
  })

  authed(http, "POST", "/device/invites/revoke", async (ctx, hash, body) => {
    const inviteId = str(body.inviteId)
    if (!inviteId || inviteId.length > 64) return bad()
    const r = await ctx.runMutation(internal.inviteLinks.revokeForDevice, { tokenHash: hash, inviteId })
    if (r === null) return unauthorized()
    return r ? json({ ok: true }) : failure({ error: "not-found" })
  })
}
