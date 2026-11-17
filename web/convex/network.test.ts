// @vitest-environment edge-runtime
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { DAY, HOUR, MINUTE, sha256Hex } from "./model"
import { pairCode } from "./network"
import schema from "./schema"
import { PAIR_INFO, generateKeyPair, openWithInfo, pairTokenAad } from "../src/lib/seal"

// Phase 2: members, devices, pairing, encrypted pings. Shapes follow docs/device-api.md.
// The server never decrypts, so random bytes stand in for HPKE output here.

const modules = import.meta.glob("./**/*.*s")
const MAC = "mac-token-used-only-in-tests"
const OWNER = "owner@example.com"

beforeEach(() => {
  process.env.MAC_TOKEN = MAC
  delete process.env.OWNER_EMAIL
  delete process.env.WEB_URL
})

afterEach(() => {
  delete process.env.OWNER_EMAIL
  vi.useRealTimers()
})

type T = ReturnType<typeof convexTest>
type As = ReturnType<T["withIdentity"]>
type Env = { deviceId: string; enc: string; ct: string }

function setup() {
  return convexTest(schema, modules)
}

function bytes(n: number) {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b))
const b64url = (b: Uint8Array) => b64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const key = () => b64(bytes(32))
const ct = (n = 40) => b64(bytes(n))
const newRef = () => b64url(bytes(16))
const seal = (ids: string[]): Env[] => ids.map((deviceId) => ({ deviceId, enc: key(), ct: ct() }))

/** A member as the migration leaves one: signed in once, memberAt set. */
async function member(t: T, name: string, email: string) {
  const userId = await t.run((ctx) => ctx.db.insert("users", { email, name, memberAt: Date.now() }))
  return { userId: userId as string, as: t.withIdentity({ subject: `${userId}|s-${name}` }) }
}

/** The network invite flow: inviter makes a link on the web, the person types the email, signs in, claims. */
async function invite(t: T, inviter: As, name: string, email: string) {
  const made = await inviter.action(api.inviteLinks.create, { name })
  if (!made.ok) throw new Error(made.error)
  const token = new URL(made.url).searchParams.get("i")!
  expect(await t.mutation(api.inviteLinks.start, { token, email })).toEqual({ ok: true })
  const userId = await t.run((ctx) => ctx.db.insert("users", { email }))
  const as = t.withIdentity({ subject: `${userId}|s-${name}` })
  expect(await as.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: true, name })
  return { userId: userId as string, as }
}

function post(t: T, path: string, body: unknown, headers: Record<string, string> = {}) {
  return t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function dev(t: T, token: string, method: "GET" | "POST", path: string, body?: unknown) {
  return t.fetch(path, {
    method,
    headers: { Authorization: `Device ${token}`, "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
  })
}

async function devJson(t: T, token: string, method: "GET" | "POST", path: string, body?: unknown, status = 200) {
  const res = await dev(t, token, method, path, body)
  const json = (await res.json()) as any
  expect({ status: res.status, json }).toMatchObject({ status })
  return json
}

type Claimed = { ok: true; status: "approved"; sealedToken: { enc: string; ct: string }; deviceId: string; userId: string; name: string }

/** What the Mac does with an approved claim: open the token with its private key. */
function openToken(privateKey: string, pairId: string, body: Claimed) {
  return openWithInfo(new TextEncoder().encode(PAIR_INFO), privateKey, body.sealedToken, pairTokenAad(pairId, body.userId))
}

/**
 * Full pairing: start, the signed-in member types the Mac's code on /pair, the Mac claims and
 * opens its sealed token.
 */
async function pairMac(t: T, as: As, name = "MacBook") {
  const pairId = b64url(bytes(16))
  const secret = b64url(bytes(32))
  const secretHash = sha256Hex(secret)
  const { publicKey, privateKey } = await generateKeyPair()
  const start = await post(t, "/device/pair/start", { pairId, secretHash, publicKey, name })
  expect(start.status).toBe(200)
  const started = (await start.json()) as { ok: boolean; expiresAt: number }
  expect(started.ok).toBe(true)
  expect(await as.query(api.devices.pairing, { pairId, secretHash })).toEqual({ status: "pending", name, expiresAt: started.expiresAt })
  const early = await post(t, "/device/pair/claim", { pairId, secret })
  expect(early.status).toBe(202)
  expect(await early.json()).toEqual({ ok: true, status: "pending" })
  const code = pairCode(pairId, publicKey)
  expect(await as.mutation(api.devices.approvePairing, { pairId, secretHash, code })).toEqual({ ok: true })
  expect(await as.query(api.devices.pairing, { pairId, secretHash })).toEqual({ status: "approved" })
  const res = await post(t, "/device/pair/claim", { pairId, secret })
  expect(res.status).toBe(200)
  const body = (await res.json()) as Claimed
  expect(body).toMatchObject({ ok: true, status: "approved" })
  // Only the sealed form ever leaves the server.
  expect(body).not.toHaveProperty("token")
  const token = await openToken(privateKey, pairId, body)
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  return { token, deviceId: body.deviceId, userId: body.userId, publicKey, privateKey, pairId, secret, secretHash, code, sealedToken: body.sealedToken }
}

async function registerWeb(as: As) {
  const r = await as.mutation(api.devices.registerWeb, { publicKey: key(), name: "Chrome" })
  if (!r.ok) throw new Error(r.error)
  return r.deviceId
}

async function sync(t: T, token: string, body: Record<string, unknown> = {}) {
  return (await devJson(t, token, "POST", "/device/sync", body)) as { ok: true; now: number; deviceId: string; messages: any[] }
}

const count = (t: T, table: "messages" | "taskStatus" | "contacts" | "devices" | "senders" | "inviteLinks" | "users" | "invites" | "rateLimits" | "pairRequests" | "commands") =>
  t.run(async (ctx) => (await ctx.db.query(table).collect()).length)

/** Viki and Dominik know each other; Dominik has a Mac, Viki a browser and a Mac. Cyril is a stranger. */
async function network(t: T) {
  const D = await member(t, "Dominik", "dominik@example.com")
  const V = await invite(t, D.as, "Viki", "viki@example.com")
  const C = await member(t, "Cyril", "cyril@example.com")
  const dMac = await pairMac(t, D.as, "Dominikův Mac")
  const vMac = await pairMac(t, V.as, "Vikin Mac")
  const vWeb = await registerWeb(V.as)
  const cMac = await pairMac(t, C.as, "Cyrilův Mac")
  return { D, V, C, dMac, vMac, vWeb, cMac }
}

describe("pairing", () => {
  test("happy path: one token, only its hash stored, device is active and named", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const mac = await pairMac(t, D.as, "Dominikův Mac")
    expect(mac.userId).toBe(D.userId)
    const stored = await t.run((ctx) => ctx.db.get(mac.deviceId as Id<"devices">))
    expect(stored).toMatchObject({ userId: D.userId, kind: "mac", publicKey: mac.publicKey, name: "Dominikův Mac", tokenHash: sha256Hex(mac.token) })
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("devices").collect()))).not.toContain(mac.token)
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("pairRequests").collect()))).not.toContain(mac.token)

    expect(await devJson(t, mac.token, "GET", "/device/me")).toEqual({
      ok: true,
      deviceId: mac.deviceId,
      userId: D.userId,
      name: "Dominik",
      deviceName: "Dominikův Mac",
    })

    // Claiming again (a retry after a lost answer) gets the same sealed token and no new device,
    // until the request expires.
    const again = await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ status: "approved", deviceId: mac.deviceId, sealedToken: mac.sealedToken })
    expect(await count(t, "devices")).toBe(1)
    await t.run(async (ctx) => {
      const r = await ctx.db.query("pairRequests").first()
      await ctx.db.patch(r!._id, { expiresAt: Date.now() - 1 })
    })
    const late = await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })
    expect(late.status).toBe(404)
    expect(await late.json()).toEqual({ ok: false, error: "not-found" })
    expect(await t.mutation(internal.cleanup.network, {})).toMatchObject({ pairRequests: 1 })
  })

  test("wrong secret, wrong hash, someone else, expiry, signed out, not a member", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const C = await member(t, "Cyril", "cyril@example.com")
    const pairId = b64url(bytes(16))
    const secret = b64url(bytes(32))
    const secretHash = sha256Hex(secret)
    const publicKey = key()
    const code = pairCode(pairId, publicKey)
    expect((await post(t, "/device/pair/start", { pairId, secretHash, publicKey, name: "Mac" })).status).toBe(200)
    // Same pairId twice.
    const dup = await post(t, "/device/pair/start", { pairId, secretHash, publicKey: key(), name: "Mac" })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ ok: false, error: "pair-exists" })

    // Wrong hash: nothing changes.
    const wrongHash = sha256Hex(b64url(bytes(32)))
    expect(await D.as.query(api.devices.pairing, { pairId, secretHash: wrongHash })).toEqual({ status: "invalid" })
    expect(await D.as.mutation(api.devices.approvePairing, { pairId, secretHash: wrongHash, code })).toEqual({ ok: false, error: "invalid" })
    const req = await t.run((ctx) => ctx.db.query("pairRequests").first())
    expect(req?.userId).toBeUndefined()

    // Wrong secret on claim: 404, and the request still works with the right one.
    const wrong = await post(t, "/device/pair/claim", { pairId, secret: b64url(bytes(32)) })
    expect(wrong.status).toBe(404)
    expect((await post(t, "/device/pair/claim", { pairId, secret })).status).toBe(202)

    // Signed out and non-members cannot see or approve it.
    expect(await t.query(api.devices.pairing, { pairId, secretHash })).toEqual({ status: "signedOut" })
    expect(await t.mutation(api.devices.approvePairing, { pairId, secretHash, code })).toEqual({ ok: false, error: "not-member" })
    const strangerId = await t.run((ctx) => ctx.db.insert("users", { email: "x@example.com" }))
    const stranger = t.withIdentity({ subject: `${strangerId}|s` })
    expect(await stranger.query(api.devices.pairing, { pairId, secretHash })).toEqual({ status: "notMember" })
    expect(await stranger.mutation(api.devices.approvePairing, { pairId, secretHash, code })).toEqual({ ok: false, error: "not-member" })

    // First approver wins; another member gets "invalid" and the Mac lands with the first.
    expect(await D.as.mutation(api.devices.approvePairing, { pairId, secretHash, code })).toEqual({ ok: true })
    expect(await C.as.mutation(api.devices.approvePairing, { pairId, secretHash, code })).toEqual({ ok: false, error: "invalid" })
    expect(await C.as.query(api.devices.pairing, { pairId, secretHash })).toEqual({ status: "invalid" })
    const claimed = (await (await post(t, "/device/pair/claim", { pairId, secret })).json()) as any
    expect(claimed.userId).toBe(D.userId)

    // Expiry: an unapproved request dies after 10 minutes and the cron removes it.
    const p2 = b64url(bytes(16))
    const s2 = b64url(bytes(32))
    const k2 = key()
    await post(t, "/device/pair/start", { pairId: p2, secretHash: sha256Hex(s2), publicKey: k2, name: "Late" })
    await t.run(async (ctx) => {
      const r = await ctx.db.query("pairRequests").withIndex("by_pairId", (q) => q.eq("pairId", p2)).first()
      expect(r!.expiresAt - r!.createdAt).toBe(10 * MINUTE)
      await ctx.db.patch(r!._id, { expiresAt: Date.now() - 1 })
    })
    expect(await D.as.query(api.devices.pairing, { pairId: p2, secretHash: sha256Hex(s2) })).toEqual({ status: "invalid" })
    expect(await D.as.mutation(api.devices.approvePairing, { pairId: p2, secretHash: sha256Hex(s2), code: pairCode(p2, k2) })).toEqual({ ok: false, error: "invalid" })
    expect((await post(t, "/device/pair/claim", { pairId: p2, secret: s2 })).status).toBe(404)
    expect(await t.mutation(internal.cleanup.network, {})).toMatchObject({ pairRequests: 1 })
    // Only the claimed one is left, until its own 10 minutes are up.
    expect((await t.run((ctx) => ctx.db.query("pairRequests").collect())).map((r) => r.pairId)).toEqual([pairId])
  })

  test("malformed starts are refused; 10 starts per hour for the whole server (pairGuard)", async () => {
    const t = setup()
    const good = () => ({ pairId: b64url(bytes(16)), secretHash: sha256Hex(b64url(bytes(32))), publicKey: key(), name: "Mac" })
    for (const body of [
      { ...good(), pairId: "short" },
      { ...good(), secretHash: "ABC" },
      { ...good(), publicKey: b64(bytes(31)) },
      { ...good(), name: "" },
      { ...good(), name: "x".repeat(61) },
      "not json",
      [],
    ]) {
      const res = await post(t, "/device/pair/start", body)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: "bad-request" })
    }
    expect((await post(t, "/device/pair/claim", { pairId: "x", secret: "short" })).status).toBe(400)
    for (let i = 0; i < 10; i++) expect((await post(t, "/device/pair/start", good())).status).toBe(200)
    const eleventh = await post(t, "/device/pair/start", good())
    expect(eleventh.status).toBe(429)
    expect(await eleventh.json()).toEqual({ ok: false, error: "rate-limited" })
    expect(await count(t, "pairRequests")).toBe(10)
    // Next hour.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", "pairGuard")).first()
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 })
    })
    expect((await post(t, "/device/pair/start", good())).status).toBe(200)
  })
})

describe("pairing security (regressions)", () => {
  /** A pairing request made by whoever runs the Mac app, as the Mac does it. */
  async function startPairing(t: T, name: string) {
    const pairId = b64url(bytes(16))
    const secret = b64url(bytes(32))
    const secretHash = sha256Hex(secret)
    const keys = await generateKeyPair()
    expect((await post(t, "/device/pair/start", { pairId, secretHash, publicKey: keys.publicKey, name })).status).toBe(200)
    return { pairId, secret, secretHash, ...keys, code: pairCode(pairId, keys.publicKey) }
  }
  const otherCode = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0")

  test("pair phishing: a link alone cannot add a Mac to someone's account; five wrong codes kill it", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const V = await invite(t, D.as, "Viki", "viki@example.com")
    const vMac = await pairMac(t, V.as, "Vikin Mac")
    // The attacker runs pair/start (no auth needed) and sends Viki the /pair link for it.
    const evil = await startPairing(t, "MacBook Pro")
    const link = { pairId: evil.pairId, secretHash: evil.secretHash }
    expect(await V.as.query(api.devices.pairing, link)).toEqual({ status: "pending", name: "MacBook Pro", expiresAt: expect.any(Number) })
    // The query never gives the code (or the key) away.
    expect(JSON.stringify(await V.as.query(api.devices.pairing, link))).not.toContain(evil.code)

    // Viki types the code her own Mac shows: wrong for this request, nothing approved.
    expect(await V.as.mutation(api.devices.approvePairing, { ...link, code: vMac.code })).toEqual({ ok: false, error: "bad-code" })
    expect(await V.as.mutation(api.devices.approvePairing, { ...link, code: "" })).toEqual({ ok: false, error: "bad-code" })
    const pending = await post(t, "/device/pair/claim", { pairId: evil.pairId, secret: evil.secret })
    expect(pending.status).toBe(202)
    expect(await V.as.query(api.devices.pairing, link)).toMatchObject({ status: "pending" })

    // Guessing is capped: the fifth wrong code deletes the request, the right one is too late.
    expect(await V.as.mutation(api.devices.approvePairing, { ...link, code: otherCode(evil.code) })).toEqual({ ok: false, error: "bad-code" })
    expect(await V.as.mutation(api.devices.approvePairing, { ...link, code: "000000x" })).toEqual({ ok: false, error: "bad-code" })
    expect(await V.as.mutation(api.devices.approvePairing, { ...link, code: otherCode(otherCode(evil.code)) })).toEqual({ ok: false, error: "invalid" })
    expect(await V.as.mutation(api.devices.approvePairing, { ...link, code: evil.code })).toEqual({ ok: false, error: "invalid" })
    expect(await V.as.query(api.devices.pairing, link)).toEqual({ status: "invalid" })
    const gone = await post(t, "/device/pair/claim", { pairId: evil.pairId, secret: evil.secret })
    expect(gone.status).toBe(404)

    // Viki's account still has only her own Mac, so nobody has to seal for the attacker's key.
    const view = await V.as.query(api.contacts.list, {})
    if (view.status !== "member") throw new Error("not member")
    expect(view.me.devices.map((d) => d.publicKey)).toEqual([vMac.publicKey])
    expect(await count(t, "devices")).toBe(1)
  })

  test("a Mac that joined anyway is listed and its person removes it from the web or another Mac", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const V = await invite(t, D.as, "Viki", "viki@example.com")
    const vMac = await pairMac(t, V.as, "Vikin Mac")
    // Talked into typing the code: the attacker's Mac is in, but visible with its name and time.
    const evilMac = await pairMac(t, V.as, "MacBook Pro")
    const view = await V.as.query(api.contacts.list, {})
    if (view.status !== "member") throw new Error("not member")
    expect(view.me.devices.find((d) => d.deviceId === evilMac.deviceId)).toMatchObject({ kind: "mac", name: "MacBook Pro", createdAt: expect.any(Number) })

    // Someone else cannot remove it; Viki can, from her other Mac or from the web.
    expect(await D.as.mutation(api.devices.revoke, { deviceId: evilMac.deviceId })).toBe(false)
    const foreign = await dev(t, (await pairMac(t, D.as, "Dominikův Mac")).token, "POST", "/device/devices/revoke", { deviceId: evilMac.deviceId })
    expect(foreign.status).toBe(404)
    expect(await devJson(t, vMac.token, "POST", "/device/devices/revoke", { deviceId: evilMac.deviceId })).toEqual({ ok: true })
    expect((await dev(t, evilMac.token, "GET", "/device/me")).status).toBe(401)
    expect((await dev(t, "x".repeat(43), "POST", "/device/devices/revoke", { deviceId: vMac.deviceId })).status).toBe(401)
    expect((await dev(t, vMac.token, "POST", "/device/devices/revoke", {})).status).toBe(400)
    // Revoked during the claim window: claiming again does not bring it back.
    const again = await post(t, "/device/pair/claim", { pairId: evilMac.pairId, secret: evilMac.secret })
    expect(again.status).toBe(404)

    const webMac = await pairMac(t, V.as, "Další Mac")
    expect(await V.as.mutation(api.devices.revoke, { deviceId: webMac.deviceId })).toBe(true)
    expect((await dev(t, webMac.token, "GET", "/device/me")).status).toBe(401)
    const after = await V.as.query(api.contacts.list, {})
    if (after.status !== "member") throw new Error("not member")
    expect(after.me.devices.map((d) => d.deviceId)).toEqual([vMac.deviceId])
  })

  test("claim race: a stolen pairing URL yields only a token sealed to the real Mac's key", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const V = await invite(t, D.as, "Viki", "viki@example.com")
    const mac = await startPairing(t, "Vikin Mac")
    expect(await V.as.mutation(api.devices.approvePairing, { pairId: mac.pairId, secretHash: mac.secretHash, code: mac.code })).toEqual({ ok: true })

    // Someone who saw the URL polls first and wins the race.
    const stolenRes = await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })
    expect(stolenRes.status).toBe(200)
    const stolen = (await stolenRes.json()) as Claimed
    expect(stolen).not.toHaveProperty("token")
    expect(JSON.stringify(stolen)).not.toMatch(/"[A-Za-z0-9_-]{43}"/)
    const attacker = await generateKeyPair()
    await expect(openToken(attacker.privateKey, mac.pairId, stolen)).rejects.toThrow()

    // The real Mac claims two seconds later: same device, same sealed token, and only it can open it.
    const realRes = await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })
    expect(realRes.status).toBe(200)
    const real = (await realRes.json()) as Claimed
    expect(real).toEqual(stolen)
    const token = await openToken(mac.privateKey, mac.pairId, real)
    // Bound to its pairing and account.
    await expect(openToken(mac.privateKey, b64url(bytes(16)), real)).rejects.toThrow()
    await expect(openWithInfo(new TextEncoder().encode(PAIR_INFO), mac.privateKey, real.sealedToken, pairTokenAad(mac.pairId, D.userId))).rejects.toThrow()
    expect(await devJson(t, token, "GET", "/device/me")).toMatchObject({ deviceId: real.deviceId, userId: V.userId, name: "Viki", deviceName: "Vikin Mac" })
    expect(await count(t, "devices")).toBe(1)
    const stored = JSON.stringify(await t.run(async (ctx) => [await ctx.db.query("devices").collect(), await ctx.db.query("pairRequests").collect()]))
    expect(stored).not.toContain(token)
  })

  test("two claims racing past the first step still make one device and one token", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const mac = await startPairing(t, "Mac")
    expect(await D.as.mutation(api.devices.approvePairing, { pairId: mac.pairId, secretHash: mac.secretHash, code: mac.code })).toEqual({ ok: true })
    const step = await t.mutation(internal.devices.pairClaim, { pairId: mac.pairId, secretHash: mac.secretHash })
    expect(step).toMatchObject({ status: "seal", publicKey: mac.publicKey, userId: D.userId })
    const first = { enc: key(), ct: ct(59) }
    const second = { enc: key(), ct: ct(59) }
    const finish = (tokenHash: string, sealedToken: { enc: string; ct: string }) =>
      t.mutation(internal.devices.pairFinish, { pairId: mac.pairId, secretHash: mac.secretHash, userId: D.userId, tokenHash, sealedToken })
    const a = await finish(sha256Hex("a"), first)
    const b = await finish(sha256Hex("b"), second)
    expect(a).toMatchObject({ status: "approved", sealedToken: first })
    expect(b).toEqual(a)
    expect(await count(t, "devices")).toBe(1)
    expect((await t.run((ctx) => ctx.db.query("devices").first()))?.tokenHash).toBe(sha256Hex("a"))
    // A token sealed for another account is refused.
    const other = await startPairing(t, "Jiný")
    await D.as.mutation(api.devices.approvePairing, { pairId: other.pairId, secretHash: other.secretHash, code: other.code })
    expect(
      await t.mutation(internal.devices.pairFinish, { pairId: other.pairId, secretHash: other.secretHash, userId: "someone-else", tokenHash: sha256Hex("c"), sealedToken: first }),
    ).toEqual({ status: "not-found" })
    expect(await count(t, "devices")).toBe(1)
  })

  test("claims are rate limited per pairing request; a polling Mac stays far below", async () => {
    const t = setup()
    const mac = await startPairing(t, "Mac")
    const other = await startPairing(t, "Jiný Mac")
    for (let i = 0; i < 60; i++) {
      expect((await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })).status).toBe(202)
    }
    const limited = await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ ok: false, error: "rate-limited" })
    // Per request, and junk with a wrong secret is not counted.
    expect((await post(t, "/device/pair/claim", { pairId: other.pairId, secret: other.secret })).status).toBe(202)
    expect((await post(t, "/device/pair/claim", { pairId: other.pairId, secret: b64url(bytes(32)) })).status).toBe(404)
    // Next minute.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", `claim:${mac.pairId}`)).first()
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 })
    })
    expect((await post(t, "/device/pair/claim", { pairId: mac.pairId, secret: mac.secret })).status).toBe(202)
  })

  test("the pairing code matches the documented derivation", () => {
    // docs/device-api.md, "Pairing code". The Mac computes the same six digits.
    expect(pairCode("AbCdEfGhIjKlMnOpQrStUv", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")).toBe("309365")
    for (let i = 0; i < 20; i++) expect(pairCode(b64url(bytes(16)), key())).toMatch(/^[0-9]{6}$/)
  })
})

describe("invites and contacts", () => {
  test("a network invite makes a contact both ways, never a v2 sender", async () => {
    const t = setup()
    process.env.WEB_URL = "https://example.test/"
    const D = await member(t, "Dominik", "dominik@example.com")
    const made = await D.as.action(api.inviteLinks.create, { name: "Viki" })
    if (!made.ok) throw new Error(made.error)
    expect(made.url).toMatch(/^https:\/\/example\.test\/\?i=[A-Za-z0-9_-]{43}$/)
    const token = new URL(made.url).searchParams.get("i")!
    expect(await t.query(api.inviteLinks.check, { token })).toEqual({ ok: true, name: "Viki", inviterName: "Dominik" })
    expect(await D.as.query(api.inviteLinks.mine, {})).toEqual([
      { inviteId: made.inviteId, name: "Viki", email: null, createdAt: expect.any(Number), expiresAt: made.expiresAt },
    ])
    expect(await t.mutation(api.inviteLinks.start, { token, email: "Viki@Example.com" })).toEqual({ ok: true })
    expect(await t.query(api.invites.check, { email: "viki@example.com" })).toBe(true)

    const vId = await t.run((ctx) => ctx.db.insert("users", { email: "viki@example.com" }))
    const V = t.withIdentity({ subject: `${vId}|s` })
    expect(await V.query(api.senders.me, {})).toEqual({ status: "notMember", email: "viki@example.com" })
    expect(await V.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: true, name: "Viki" })
    expect(await V.query(api.senders.me, {})).toEqual({
      status: "member",
      name: "Viki",
      userId: vId,
      onboarded: false,
      inviterName: "Dominik",
    })
    // No plaintext v2 path for new people.
    expect(await count(t, "senders")).toBe(0)
    expect(await V.mutation(api.relay.create, { title: "x", dueAt: Date.now() })).toEqual({ ok: false, error: "not-member" })
    await V.mutation(api.senders.finishOnboarding, {})
    expect(await V.query(api.senders.me, {})).toMatchObject({ onboarded: true })

    const dList = await D.as.query(api.contacts.list, {})
    if (dList.status !== "member") throw new Error("D not member")
    expect(dList.contacts).toEqual([{ userId: vId, name: "Viki", hasMac: false, online: false, macLastSeen: null, devices: [] }])
    const vList = await V.query(api.contacts.list, {})
    if (vList.status !== "member") throw new Error("V not member")
    expect(vList.me).toEqual({ userId: vId, name: "Viki", devices: [] })
    expect(vList.contacts.map((c) => c.userId)).toEqual([D.userId])

    // The link is used up; it no longer shows.
    expect(await t.query(api.inviteLinks.check, { token })).toEqual({ ok: false })
    expect(await D.as.query(api.inviteLinks.mine, {})).toEqual([])
    expect(await t.query(api.contacts.list, {})).toEqual({ status: "signedOut" })
  })

  test("invites over the device API: create, list, revoke, limits", async () => {
    const t = setup()
    const D = await member(t, "Dominik", "dominik@example.com")
    const mac = await pairMac(t, D.as)
    const created = await devJson(t, mac.token, "POST", "/device/invites", { name: "Michal" })
    expect(created).toEqual({ ok: true, inviteId: expect.any(String), url: expect.stringMatching(/^https:\/\/pingme\.macaly\.app\/\?i=/), expiresAt: expect.any(Number) })
    const token = new URL(created.url).searchParams.get("i")!
    await t.mutation(api.inviteLinks.start, { token, email: "michal@example.com" })
    expect(await devJson(t, mac.token, "GET", "/device/invites")).toEqual({
      ok: true,
      invites: [{ inviteId: created.inviteId, name: "Michal", email: "michal@example.com", createdAt: expect.any(Number), expiresAt: created.expiresAt }],
    })
    // Revoked: the link is dead and the email loses its code.
    expect(await devJson(t, mac.token, "POST", "/device/invites/revoke", { inviteId: created.inviteId })).toEqual({ ok: true })
    expect(await t.query(api.inviteLinks.check, { token })).toEqual({ ok: false })
    expect(await t.query(api.invites.check, { email: "michal@example.com" })).toBe(false)
    expect(await devJson(t, mac.token, "POST", "/device/invites/revoke", { inviteId: created.inviteId }, 404)).toEqual({ ok: false, error: "not-found" })

    // Someone else's invite cannot be revoked or listed.
    const C = await member(t, "Cyril", "cyril@example.com")
    const cInvite = await C.as.action(api.inviteLinks.create, { name: "Eva" })
    if (!cInvite.ok) throw new Error("create")
    expect(await devJson(t, mac.token, "POST", "/device/invites/revoke", { inviteId: cInvite.inviteId }, 404)).toMatchObject({ error: "not-found" })
    expect(await D.as.mutation(api.inviteLinks.revoke, { inviteId: cInvite.inviteId })).toBe(false)
    expect((await devJson(t, mac.token, "GET", "/device/invites")).invites).toEqual([])

    expect(await devJson(t, mac.token, "POST", "/device/invites", { name: "" }, 400)).toEqual({ ok: false, error: "bad-name" })
    // 10 new links per hour (one made above).
    for (let i = 0; i < 9; i++) await devJson(t, mac.token, "POST", "/device/invites", { name: `P${i}` })
    expect(await devJson(t, mac.token, "POST", "/device/invites", { name: "Too many" }, 429)).toEqual({ ok: false, error: "rate-limited" })
    const stranger = await t.run((ctx) => ctx.db.insert("users", { email: "s@example.com" }))
    expect(await t.withIdentity({ subject: `${stranger}|s` }).action(api.inviteLinks.create, { name: "X" })).toEqual({ ok: false, error: "not-member" })
  })
})

describe("contact requests between members", () => {
  test("an invite to someone already in asks first, and either side can end a contact", async () => {
    const t = setup()
    const V = await member(t, "Viki", "viki@example.com")
    const M = await member(t, "Mallory", "mallory@example.com")
    const link = async () => {
      const made = await M.as.action(api.inviteLinks.create, { name: "Viki" })
      if (!made.ok) throw new Error(made.error)
      const token = new URL(made.url).searchParams.get("i")!
      // Anyone who knows Viki's email can bind it to their link, without signing in as her.
      expect(await t.mutation(api.inviteLinks.start, { token, email: "viki@example.com" })).toEqual({ ok: true })
      return token
    }
    const names = async (as: As) => {
      const r = await as.query(api.contacts.list, {})
      if (r.status !== "member") throw new Error(r.status)
      return r.contacts.map((c) => c.name)
    }

    // Opening it signed in only asks; nothing changes until she says yes.
    const token = await link()
    expect(await V.as.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: false, error: "confirm", inviterName: "Mallory" })
    expect(await names(V.as)).toEqual([])
    expect(await names(M.as)).toEqual([])
    expect(await V.as.mutation(api.inviteLinks.claim, { token, addContact: true })).toEqual({ ok: true, name: "Viki" })
    expect(await names(V.as)).toEqual(["Mallory"])
    expect(await names(M.as)).toEqual(["Viki"])

    // Either side ends it, for both.
    expect(await V.as.mutation(api.contacts.remove, { userId: M.userId })).toEqual({ ok: true })
    expect(await names(M.as)).toEqual([])
    expect(await V.as.mutation(api.contacts.remove, { userId: M.userId })).toEqual({ ok: false, error: "not-contact" })
    expect(await V.as.mutation(api.contacts.remove, { userId: "nonsense" })).toEqual({ ok: false, error: "not-contact" })
    const strangerId = await t.run((ctx) => ctx.db.insert("users", { email: "s@example.com" }))
    expect(await t.withIdentity({ subject: `${strangerId}|s` }).mutation(api.contacts.remove, { userId: M.userId })).toEqual({ ok: false, error: "not-member" })

    // The same from the Mac.
    const again = await link()
    expect(await V.as.mutation(api.inviteLinks.claim, { token: again, addContact: true })).toEqual({ ok: true, name: "Viki" })
    const mac = await pairMac(t, V.as)
    expect(await devJson(t, mac.token, "POST", "/device/contacts/remove", { userId: M.userId })).toEqual({ ok: true })
    expect(await names(M.as)).toEqual([])
    expect(await devJson(t, mac.token, "POST", "/device/contacts/remove", { userId: M.userId }, 404)).toEqual({ ok: false, error: "not-found" })
    expect(await devJson(t, mac.token, "POST", "/device/contacts/remove", {}, 400)).toMatchObject({ ok: false })
  })
})

describe("encrypted pings between members", () => {
  test("send, deliver, status, typing, reply: each side sees only its own ciphertext", async () => {
    const t = setup()
    const { D, V, C, dMac, vMac, vWeb, cMac } = await network(t)

    // Viki's browser reads her contacts: Dominik's Mac to seal to, her own devices for her copy.
    const vList = await V.as.query(api.contacts.list, {})
    if (vList.status !== "member") throw new Error("V")
    expect(vList.contacts).toEqual([
      { userId: D.userId, name: "Dominik", hasMac: true, online: true, macLastSeen: expect.any(Number), devices: [{ deviceId: dMac.deviceId, kind: "mac", publicKey: dMac.publicKey }] },
    ])
    expect(vList.me.devices.map((d) => [d.deviceId, d.kind]).sort()).toEqual([[vMac.deviceId, "mac"], [vWeb, "web"]].sort())
    // Cyril is nobody's contact.
    const cList = await C.as.query(api.contacts.list, {})
    expect(cList.status === "member" && cList.contacts).toEqual([])

    const ref = newRef()
    const envelopes = seal([dMac.deviceId])
    const titleEnvelopes = seal([vWeb, vMac.deviceId])
    expect(
      await V.as.mutation(api.messages.send, { ref, to: D.userId, forAgent: false, urgency: "orange", envelopes, titleEnvelopes }),
    ).toEqual({ ok: true, ref })

    // Dominik's Mac gets exactly its envelope; Cyril's and Viki's Macs get nothing.
    const got = await sync(t, dMac.token)
    expect(got.deviceId).toBe(dMac.deviceId)
    expect(got.messages).toEqual([
      {
        ref,
        fromUserId: V.userId,
        fromName: "Viki",
        fromAgent: null,
        toUserId: D.userId,
        forAgent: false,
        urgency: "orange",
        dueAt: expect.any(Number),
        repeat: null,
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
        envelope: { enc: envelopes[0].enc, ct: envelopes[0].ct },
        text: null,
        unencrypted: false,
      },
    ])
    expect(got.messages[0].expiresAt - got.messages[0].createdAt).toBe(7 * DAY)
    const feed = await t.query(api.devices.feed, { token: dMac.token })
    expect(feed).toEqual({ ok: true, deviceId: dMac.deviceId, messages: got.messages })
    expect((await sync(t, cMac.token)).messages).toEqual([])
    expect((await sync(t, vMac.token)).messages).toEqual([])
    expect(await t.query(api.devices.feed, { token: cMac.token })).toEqual({ ok: true, deviceId: cMac.deviceId, messages: [] })

    // Delivered to Dominik's only Mac: the message is gone from the server, the status stays.
    await sync(t, dMac.token, { ack: [ref] })
    expect(await count(t, "messages")).toBe(0)
    const statusRow = () => t.run((ctx) => ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", ref)).first())
    expect((await statusRow())?.status).toBe("queued")

    // Cyril's Mac tries to write to someone else's ping: nothing changes.
    const T0 = Date.now()
    await sync(t, cMac.token, { statuses: [{ ref, status: "done", at: T0 }], typing: ref })
    expect(await devJson(t, cMac.token, "POST", "/device/reply", { ref, at: T0, envelopes: seal([vWeb]) }, 404)).toEqual({ ok: false, error: "not-found" })
    // Viki's own Mac is the sender, not the recipient: it cannot mark her ping either.
    await sync(t, vMac.token, { statuses: [{ ref, status: "done", at: T0 }] })
    const untouched = await statusRow()
    expect([untouched?.status, untouched?.typingUntil, untouched?.replyEnvelopes]).toEqual(["queued", undefined, undefined])

    // Dominik's Mac reports, types, replies to all of Viki's devices.
    await sync(t, dMac.token, { statuses: [{ ref, status: "popped", at: T0 }, { ref, status: "seen", at: T0 + 1000 }] })
    await sync(t, dMac.token, { typing: ref })
    let mine = await V.as.query(api.messages.mine, { deviceId: vWeb })
    if (mine.status !== "member") throw new Error("V")
    expect(mine.deviceActive).toBe(true)
    expect(mine.rows[0]).toMatchObject({ ref, status: "seen", statusAt: T0 + 1000, typingUntil: expect.any(Number), reply: null, replyAt: null })
    const replyEnv = seal([vWeb, vMac.deviceId])
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at: T0 + 2000, envelopes: replyEnv })).toEqual({ ok: true })

    mine = await V.as.query(api.messages.mine, { deviceId: vWeb })
    if (mine.status !== "member") throw new Error("V")
    expect(mine.rows).toEqual([
      {
        ref,
        fromUserId: V.userId,
        toUserId: D.userId,
        toName: "Dominik",
        fromAgent: null,
        forAgent: false,
        urgency: "orange",
        dueAt: expect.any(Number),
        repeat: null,
        createdAt: expect.any(Number),
        status: "replied",
        statusAt: T0 + 2000,
        snoozedUntil: null,
        typingUntil: null,
        title: { enc: titleEnvelopes[0].enc, ct: titleEnvelopes[0].ct },
        reply: { enc: replyEnv[0].enc, ct: replyEnv[0].ct },
        replyAt: T0 + 2000,
      },
    ])
    // Viki's Mac sees its own copies through /device/sent.
    const sent = await devJson(t, vMac.token, "POST", "/device/sent", { refs: [ref] })
    expect(sent.rows[0]).toMatchObject({ ref, title: { enc: titleEnvelopes[1].enc }, reply: { enc: replyEnv[1].enc } })

    // Cross-user reads are impossible: Cyril and Dominik see no row of Viki's, even with her device id.
    for (const who of [C.as, D.as]) {
      const other = await who.query(api.messages.mine, { deviceId: vWeb })
      expect(other).toEqual({ status: "member", deviceActive: false, rows: [] })
      expect(await who.mutation(api.messages.ackReply, { ref, deviceId: vWeb })).toBe(false)
    }
    expect((await devJson(t, cMac.token, "POST", "/device/sent", { refs: [ref] })).rows).toEqual([])
    expect((await devJson(t, dMac.token, "POST", "/device/sent", {})).rows).toEqual([])
    const everything = JSON.stringify([await C.as.query(api.contacts.list, {}), await C.as.query(api.messages.mine, {}), await sync(t, cMac.token)])
    for (const secret of [titleEnvelopes[0].ct, replyEnv[0].ct, envelopes[0].ct, ref]) expect(everything).not.toContain(secret)

    // An older status from a retried outbox does not undo the reply; done lives 24 hours.
    await sync(t, dMac.token, { statuses: [{ ref, status: "seen", at: T0 + 1500 }] })
    expect((await statusRow())?.status).toBe("replied")
    await sync(t, dMac.token, { statuses: [{ ref, status: "done", at: T0 + 3000 }] })
    expect(await statusRow()).toMatchObject({ status: "done", expiresAt: T0 + 3000 + DAY })

    // ackReply drops only the browser's copy.
    expect(await V.as.mutation(api.messages.ackReply, { ref, deviceId: vWeb })).toBe(true)
    const after = await statusRow()
    expect(after?.replyEnvelopes?.map((e) => e.deviceId)).toEqual([vMac.deviceId])
    mine = await V.as.query(api.messages.mine, { deviceId: vWeb })
    expect(mine.status === "member" && mine.rows[0]).toMatchObject({ reply: null, replyAt: T0 + 2000 })
  })

  test("non-contacts cannot send; yourself is fine", async () => {
    const t = setup()
    const { D, V, C, dMac, vMac, cMac } = await network(t)
    const before = await count(t, "messages")
    const toD = () => ({ ref: newRef(), to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId]), titleEnvelopes: [] })
    expect(await C.as.mutation(api.messages.send, toD())).toEqual({ ok: false, error: "not-contact" })
    expect(await devJson(t, cMac.token, "POST", "/device/send", toD(), 403)).toEqual({ ok: false, error: "not-contact" })
    expect(await V.as.mutation(api.messages.send, { ...toD(), to: "nonsense" })).toEqual({ ok: false, error: "not-contact" })
    const strangerId = await t.run((ctx) => ctx.db.insert("users", { email: "s@example.com" }))
    expect(await t.withIdentity({ subject: `${strangerId}|s` }).mutation(api.messages.send, toD())).toEqual({ ok: false, error: "not-member" })
    expect(await t.mutation(api.messages.send, toD())).toEqual({ ok: false, error: "not-member" })
    expect(await count(t, "messages")).toBe(before)

    // A ping to your own other Mac needs no contact. From the agent on the Mac, marked as such.
    const ref = newRef()
    const self = await devJson(t, vMac.token, "POST", "/device/send", {
      ref,
      to: V.userId,
      urgency: "red",
      fromAgent: "Claude Code",
      envelopes: seal([vMac.deviceId]),
      titleEnvelopes: seal([vMac.deviceId]),
    })
    expect(self).toEqual({ ok: true, ref })
    const inbox = await sync(t, vMac.token)
    expect(inbox.messages[0]).toMatchObject({ ref, fromUserId: V.userId, fromAgent: "Claude Code", urgency: "red" })

    // Dominik's Mac sends to Viki (her Mac only, she has a browser too).
    const vRef = newRef()
    expect(await devJson(t, dMac.token, "POST", "/device/send", { ref: vRef, to: V.userId, forAgent: true, urgency: "green", envelopes: seal([vMac.deviceId]), titleEnvelopes: seal([dMac.deviceId]) })).toEqual({ ok: true, ref: vRef })
  })

  test("envelope targets: exact recipient Macs, own devices for the copy, sane formats, refs", async () => {
    const t = setup()
    const { D, V, C, dMac, vMac, vWeb, cMac } = await network(t)
    const base = { to: D.userId, forAgent: false, urgency: "green" }
    const send = (extra: Record<string, unknown>) =>
      V.as.mutation(api.messages.send, { ref: newRef(), ...base, envelopes: seal([dMac.deviceId]), titleEnvelopes: seal([vWeb]), ...extra } as any)
    const devices = [{ deviceId: dMac.deviceId, kind: "mac", publicKey: dMac.publicKey }]
    const stale = { ok: false, error: "stale-devices", devices, myDevices: expect.any(Array) }

    // A second Mac of Dominik makes the old device list stale.
    const dMac2 = await pairMac(t, D.as, "Druhý Mac")
    const both = [...devices, { deviceId: dMac2.deviceId, kind: "mac", publicKey: dMac2.publicKey }]
    const missing = await send({})
    expect(missing).toMatchObject({ ok: false, error: "stale-devices" })
    expect(missing.ok === false && missing.devices?.map((d) => d.deviceId).sort()).toEqual(both.map((d) => d.deviceId).sort())
    expect(missing.ok === false && missing.myDevices?.map((d) => d.deviceId).sort()).toEqual([vMac.deviceId, vWeb].sort())
    await t.run((ctx) => ctx.db.patch(dMac2.deviceId as Id<"devices">, { revokedAt: Date.now() }))

    expect(await send({})).toMatchObject({ ok: true })
    // Extra envelope for a stranger's Mac, for a web device of the recipient, for Viki herself.
    expect(await send({ envelopes: seal([dMac.deviceId, cMac.deviceId]) })).toEqual(stale)
    expect(await send({ envelopes: seal([vMac.deviceId]) })).toEqual(stale)
    expect(await send({ envelopes: seal([dMac2.deviceId]) })).toEqual(stale)
    // The sender's copy may only go to the sender's devices.
    expect(await send({ titleEnvelopes: seal([dMac.deviceId]) })).toEqual(stale)
    expect(await send({ titleEnvelopes: seal([cMac.deviceId]) })).toEqual(stale)
    expect(await send({ titleEnvelopes: [] })).toMatchObject({ ok: true })

    // Formats.
    const one = (patch: Partial<Env>) => [{ deviceId: dMac.deviceId, enc: key(), ct: ct(), ...patch }]
    for (const envelopes of [
      one({ enc: b64(bytes(31)) }),
      one({ enc: "not base64 at all, nope!!!!!!!!!!!!!!!!!!!!!" }),
      one({ ct: b64(bytes(10)) }),
      one({ ct: b64(bytes(900)) }),
      one({ ct: ct().slice(1) }),
      one({ deviceId: "garbage" }),
      [...seal([dMac.deviceId]), ...seal([dMac.deviceId])],
    ]) {
      expect(await send({ envelopes })).toEqual({ ok: false, error: "bad-envelope" })
    }
    expect(await send({ envelopes: one({ ct: b64(bytes(816)) }) })).toMatchObject({ ok: true })
    expect(await send({ ref: "too-short" })).toEqual({ ok: false, error: "bad-ref" })
    expect(await send({ urgency: "purple" })).toEqual({ ok: false, error: "bad-urgency" })
    expect(await send({ repeat: "hourly" })).toEqual({ ok: false, error: "bad-repeat" })
    expect(await send({ dueAt: Date.now() + 61 * DAY })).toEqual({ ok: false, error: "bad-time" })
    // forAgent ignores dueAt and repeat.
    const agentRef = newRef()
    expect(await send({ ref: agentRef, forAgent: true, dueAt: Date.now() + 61 * DAY, repeat: "daily" })).toEqual({ ok: true, ref: agentRef })
    const agentRow = await t.run((ctx) => ctx.db.query("messages").withIndex("by_ref", (q) => q.eq("ref", agentRef)).first())
    expect([agentRow?.forAgent, agentRow?.repeat]).toEqual([true, undefined])
    expect(Math.abs(agentRow!.dueAt - Date.now())).toBeLessThan(5000)
    expect(await devJson(t, vMac.token, "POST", "/device/send", { ref: newRef(), ...base, fromAgent: "x".repeat(41), envelopes: seal([dMac.deviceId]) }, 400)).toEqual({ ok: false, error: "bad-agent" })

    // A contact without a Mac cannot be pinged.
    const E = await invite(t, D.as, "Eva", "eva@example.com")
    expect(await D.as.mutation(api.messages.send, { ref: newRef(), to: E.userId, forAgent: false, urgency: "green", envelopes: [], titleEnvelopes: [] })).toEqual({ ok: false, error: "no-device" })

    // Same ref again from the same sender to the same person: a retry, nothing new stored.
    const ref = newRef()
    expect(await send({ ref })).toEqual({ ok: true, ref })
    const rows = await count(t, "taskStatus")
    expect(await send({ ref })).toEqual({ ok: true, ref })
    expect(await count(t, "taskStatus")).toBe(rows)
    // Someone else cannot reuse it.
    expect(await D.as.mutation(api.messages.send, { ref, to: V.userId, forAgent: false, urgency: "green", envelopes: seal([vMac.deviceId]), titleEnvelopes: [] })).toEqual({ ok: false, error: "ref-taken" })
    expect(await count(t, "taskStatus")).toBe(rows)
  })

  test("replies: only to the sender's active devices, plaintext refused", async () => {
    const t = setup()
    const { D, V, dMac, vMac, vWeb, cMac } = await network(t)
    const ref = newRef()
    await V.as.mutation(api.messages.send, { ref, to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId]), titleEnvelopes: [] })
    const at = Date.now()
    // Only foreign devices: stale, with Viki's current devices.
    const stale = await devJson(t, dMac.token, "POST", "/device/reply", { ref, at, envelopes: seal([cMac.deviceId, dMac.deviceId]) }, 409)
    expect(stale.error).toBe("stale-devices")
    expect(stale.devices.map((d: any) => d.deviceId).sort()).toEqual([vMac.deviceId, vWeb].sort())
    // A mix keeps only Viki's.
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at, envelopes: seal([vWeb, cMac.deviceId]) })).toEqual({ ok: true })
    const row = await t.run((ctx) => ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", ref)).first())
    expect(row?.replyEnvelopes?.map((e) => e.deviceId)).toEqual([vWeb])
    expect(row?.reply).toBeUndefined()
    // Never plaintext for a network ping, never both, never neither.
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at, text: "ahoj" }, 400)).toEqual({ ok: false, error: "bad-text" })
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at, text: "ahoj", envelopes: seal([vWeb]) }, 400)).toEqual({ ok: false, error: "bad-request" })
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at }, 400)).toEqual({ ok: false, error: "bad-request" })
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at, envelopes: [] }, 400)).toEqual({ ok: false, error: "bad-envelope" })
    expect(await devJson(t, dMac.token, "POST", "/device/reply", { ref, at: Date.now() + 2 * HOUR, envelopes: seal([vWeb]) }, 400)).toEqual({ ok: false, error: "bad-time" })
  })
})

describe("revoked devices", () => {
  test("a revoked Mac can do nothing, its envelopes do not keep messages alive", async () => {
    const t = setup()
    const { D, V, dMac, vWeb } = await network(t)
    const dMac2 = await pairMac(t, D.as, "Druhý Mac")
    const ref = newRef()
    await V.as.mutation(api.messages.send, { ref, to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId, dMac2.deviceId]), titleEnvelopes: seal([vWeb]) })

    // Dominik revokes the second Mac from the web.
    expect(await V.as.mutation(api.devices.revoke, { deviceId: dMac2.deviceId })).toBe(false)
    expect(await D.as.mutation(api.devices.revoke, { deviceId: dMac2.deviceId })).toBe(true)
    expect(await D.as.mutation(api.devices.revoke, { deviceId: dMac2.deviceId })).toBe(false)
    for (const [method, path] of [
      ["GET", "/device/me"],
      ["POST", "/device/sync"],
      ["POST", "/device/reply"],
      ["GET", "/device/contacts"],
      ["POST", "/device/send"],
      ["POST", "/device/sent"],
      ["POST", "/device/invites"],
      ["GET", "/device/invites"],
      ["POST", "/device/invites/revoke"],
      ["POST", "/device/unpair"],
    ] as const) {
      const body = { ref, at: Date.now(), to: V.userId, envelopes: seal([vWeb]), name: "x", inviteId: "x" }
      expect(await devJson(t, dMac2.token, method, path, body, 401)).toEqual({ ok: false, error: "unauthorized" })
    }
    expect(await t.query(api.devices.feed, { token: dMac2.token })).toEqual({ ok: false })
    // It cannot reply or change the status of the ping it was sealed for.
    const row = await t.run((ctx) => ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", ref)).first())
    expect([row?.status, row?.replyEnvelopes]).toEqual(["queued", undefined])

    // The active Mac's ack is enough: the revoked one no longer counts.
    await sync(t, dMac.token, { ack: [ref] })
    expect(await count(t, "messages")).toBe(0)

    // Unpair from the Mac itself.
    expect(await devJson(t, dMac.token, "POST", "/device/unpair")).toEqual({ ok: true })
    expect(await devJson(t, dMac.token, "GET", "/device/me", undefined, 401)).toEqual({ ok: false, error: "unauthorized" })
    const dList = await V.as.query(api.contacts.list, {})
    expect(dList.status === "member" && dList.contacts[0]).toMatchObject({ hasMac: false, online: false, devices: [] })

    // Bad schemes and junk tokens.
    for (const header of ["", "Bearer abc", `Device ${dMac.token}x`, `Device ${MAC}`, "Device "]) {
      const res = await t.fetch("/device/me", { headers: header ? { Authorization: header } : {} })
      expect(res.status).toBe(401)
    }
  })

  test("a revoked browser loses its envelopes; 10 browsers at most; the same key is the same device", async () => {
    const t = setup()
    const { D, V, dMac } = await network(t)
    const publicKey = key()
    const first = await V.as.mutation(api.devices.registerWeb, { publicKey })
    expect(await V.as.mutation(api.devices.registerWeb, { publicKey })).toEqual(first)
    if (!first.ok) throw new Error("register")
    const ref = newRef()
    await V.as.mutation(api.messages.send, { ref, to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId]), titleEnvelopes: seal([first.deviceId]) })
    const mine = await V.as.query(api.messages.mine, { deviceId: first.deviceId })
    expect(mine.status === "member" && mine.rows[0].title).not.toBeNull()

    expect(await V.as.mutation(api.devices.registerWeb, { publicKey: "short" })).toEqual({ ok: false, error: "bad-key" })
    const strangerId = await t.run((ctx) => ctx.db.insert("users", { email: "s@example.com" }))
    expect(await t.withIdentity({ subject: `${strangerId}|s` }).mutation(api.devices.registerWeb, { publicKey })).toEqual({ ok: false, error: "not-member" })

    // Ten more browsers: the least recently seen ones go, never more than 10 active.
    for (let i = 0; i < 10; i++) await registerWeb(V.as)
    const webs = await t.run(async (ctx) =>
      (await ctx.db.query("devices").withIndex("by_userId", (q) => q.eq("userId", V.userId as Id<"users">)).collect()).filter((d) => d.kind === "web"),
    )
    expect(webs.filter((d) => d.revokedAt === undefined)).toHaveLength(10)
    expect(webs.find((d) => d._id === first.deviceId)?.revokedAt).toBeDefined()
    const revoked = await V.as.query(api.messages.mine, { deviceId: first.deviceId })
    expect(revoked).toMatchObject({ status: "member", deviceActive: false })
    expect(revoked.status === "member" && revoked.rows[0]).toMatchObject({ title: null, reply: null })
  })
})

describe("rate limits", () => {
  test("31st ping in an hour to the same person fails and stores nothing; other contacts are separate", async () => {
    const t = setup()
    const { D, V, dMac, vMac } = await network(t)
    const E = await invite(t, V.as, "Eva", "eva@example.com")
    const eMac = await pairMac(t, E.as, "Evin Mac")
    for (let i = 0; i < 30; i++) {
      const res = await dev(t, vMac.token, "POST", "/device/send", { ref: newRef(), to: D.userId, envelopes: seal([dMac.deviceId]) })
      expect(res.status).toBe(200)
    }
    const before = await count(t, "messages")
    const res = await dev(t, vMac.token, "POST", "/device/send", { ref: newRef(), to: D.userId, envelopes: seal([dMac.deviceId]) })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ ok: false, error: "rate-limited" })
    // The web counts against the same window.
    expect(await V.as.mutation(api.messages.send, { ref: newRef(), to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId]), titleEnvelopes: [] })).toEqual({ ok: false, error: "rate-limited" })
    expect(await count(t, "messages")).toBe(before)
    // Another contact, and the other direction, are not limited by it.
    expect((await dev(t, vMac.token, "POST", "/device/send", { ref: newRef(), to: E.userId, envelopes: seal([eMac.deviceId]) })).status).toBe(200)
    expect((await dev(t, dMac.token, "POST", "/device/send", { ref: newRef(), to: V.userId, envelopes: seal([vMac.deviceId]) })).status).toBe(200)
    // Next hour.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", `send:${V.userId}:${D.userId}`)).first()
      await ctx.db.patch(row!._id, { expiresAt: Date.now() - 1 })
    })
    expect((await dev(t, vMac.token, "POST", "/device/send", { ref: newRef(), to: D.userId, envelopes: seal([dMac.deviceId]) })).status).toBe(200)
  })
})

describe("device API input", () => {
  test("malformed bodies, oversized bodies, contacts shape, sent list", async () => {
    const t = setup()
    const { D, V, dMac, vMac, vWeb } = await network(t)
    const raw = (path: string, body: string) =>
      t.fetch(path, { method: "POST", headers: { Authorization: `Device ${dMac.token}`, "Content-Type": "application/json" }, body })
    expect((await raw("/device/sync", "{nope")).status).toBe(400)
    expect((await raw("/device/sync", "[1]")).status).toBe(400)
    expect((await raw("/device/sync", JSON.stringify({ ack: "x" }))).status).toBe(400)
    const big = await raw("/device/send", JSON.stringify({ pad: "x".repeat(70 * 1024) }))
    expect(big.status).toBe(413)
    expect(await big.json()).toEqual({ ok: false, error: "too-large" })
    expect((await raw("/device/send", JSON.stringify({ ref: newRef(), to: V.userId, forAgent: "yes", envelopes: [] }))).status).toBe(400)
    // Junk statuses are skipped, the sync still answers.
    expect((await sync(t, dMac.token, { statuses: [5, "x", { ref: "!!", status: "done", at: 1 }, { ref: newRef(), status: "exploded", at: 1 }] })).ok).toBe(true)

    const contacts = await devJson(t, vMac.token, "GET", "/device/contacts")
    expect(contacts).toEqual({
      ok: true,
      now: expect.any(Number),
      me: {
        userId: V.userId,
        name: "Viki",
        devices: expect.arrayContaining([
          { deviceId: vMac.deviceId, kind: "mac", publicKey: vMac.publicKey, name: "Vikin Mac", createdAt: expect.any(Number), lastSeen: expect.any(Number) },
          { deviceId: vWeb, kind: "web", publicKey: expect.any(String), name: "Chrome", createdAt: expect.any(Number), lastSeen: expect.any(Number) },
        ]),
      },
      contacts: [{ userId: D.userId, name: "Dominik", hasMac: true, online: true, macLastSeen: expect.any(Number), devices: [{ deviceId: dMac.deviceId, kind: "mac", publicKey: dMac.publicKey }] }],
    })

    // Macs check in every 5 min: still online after 6, off after 12 without a keep-alive.
    await t.run((ctx) => ctx.db.patch(dMac.deviceId as Id<"devices">, { lastSeen: Date.now() - 6 * MINUTE }))
    expect((await devJson(t, vMac.token, "GET", "/device/contacts")).contacts[0]).toMatchObject({ online: true, hasMac: true })
    await t.run((ctx) => ctx.db.patch(dMac.deviceId as Id<"devices">, { lastSeen: Date.now() - 13 * MINUTE }))
    expect((await devJson(t, vMac.token, "GET", "/device/contacts")).contacts[0]).toMatchObject({ online: false, hasMac: true })
    await sync(t, dMac.token)
    expect((await devJson(t, vMac.token, "GET", "/device/contacts")).contacts[0]).toMatchObject({ online: true })

    // The sent list without refs: newest first.
    const r1 = newRef()
    const r2 = newRef()
    for (const ref of [r1, r2]) {
      await devJson(t, vMac.token, "POST", "/device/send", { ref, to: D.userId, envelopes: seal([dMac.deviceId]), titleEnvelopes: seal([vMac.deviceId]) })
    }
    const sent = await devJson(t, vMac.token, "POST", "/device/sent")
    expect(sent.rows.map((r: any) => r.ref)).toEqual([r2, r1])
    expect(sent.rows[0]).toMatchObject({ status: "queued", toName: "Dominik", title: { enc: expect.any(String) } })
  })
})

describe("legacy remote MCP", () => {
  test("stays on the v2 queue until the owner has a Mac, then goes to the owner unencrypted", async () => {
    const t = setup()
    process.env.OWNER_EMAIL = OWNER
    const O = await member(t, "Dominik", OWNER)
    // The owner's agent key from v2.
    const agentKey = `uk_${crypto.randomUUID().replace(/-/g, "")}`
    const r = await post(t, "/mac/agent-key", { name: "Michal", keyHash: sha256Hex(agentKey), keyTail: agentKey.slice(-4) }, { Authorization: `Bearer ${MAC}` })
    expect(r.status).toBe(200)
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await post(t, "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { Authorization: `Bearer ${agentKey}` })
      return ((await res.json()) as any).result.structuredContent
    }

    const before = await call("pingme", { title: "Do fronty" })
    expect(await count(t, "commands")).toBe(1)
    expect(await count(t, "messages")).toBe(0)
    expect((await call("get_status", { id: before.id })).status).toBe("queued")

    const mac = await pairMac(t, O.as, "Dominikův Mac")
    const sent = await call("pingme", { title: "Na nový Mac", urgency: "red" })
    expect(await count(t, "commands")).toBe(1)
    const inbox = await sync(t, mac.token)
    expect(inbox.messages).toEqual([
      {
        ref: sent.id,
        fromUserId: null,
        fromName: "Michal",
        fromAgent: "mcp",
        toUserId: O.userId,
        forAgent: false,
        urgency: "red",
        dueAt: expect.any(Number),
        repeat: null,
        createdAt: expect.any(Number),
        expiresAt: expect.any(Number),
        envelope: null,
        text: "Na nový Mac",
        unencrypted: true,
      },
    ])
    // The installed v2 app never sees it, and its MAC_TOKEN cannot touch the row.
    const feed = await t.query(api.macFeed.get, { key: MAC })
    expect(feed.ok && feed.commands.map((c) => c.title)).toEqual(["Do fronty"])
    await post(t, "/mac/sync", { ack: [], statuses: [{ taskRef: sent.id, status: "done", at: Date.now() }] }, { Authorization: `Bearer ${MAC}` })
    expect((await call("get_status", { id: sent.id })).status).toBe("queued")

    await sync(t, mac.token, { ack: [sent.id], statuses: [{ ref: sent.id, status: "seen", at: Date.now() }] })
    expect(await count(t, "messages")).toBe(0)
    expect((await call("get_status", { id: sent.id })).status).toBe("seen")
    // Plaintext reply only for this kind of message; envelopes are refused.
    expect(await devJson(t, mac.token, "POST", "/device/reply", { ref: sent.id, at: Date.now(), envelopes: seal([mac.deviceId]) }, 400)).toEqual({ ok: false, error: "bad-text" })
    expect(await devJson(t, mac.token, "POST", "/device/reply", { ref: sent.id, at: Date.now(), text: "  Jasně  " })).toEqual({ ok: true })
    expect(await call("get_reply", { id: sent.id })).toMatchObject({ reply: "Jasně" })
    // Not in the owner's own sent list.
    expect((await devJson(t, mac.token, "POST", "/device/sent")).rows).toEqual([])

    // Revoking the key also drops what it queued for the paired Mac.
    const late = await call("pingme", { title: "Po revoke zmizí" })
    expect(await count(t, "messages")).toBe(1)
    const senderId = (await t.run((ctx) => ctx.db.query("senders").first()))!._id
    expect((await post(t, "/mac/sender-revoke", { senderId }, { Authorization: `Bearer ${MAC}` })).status).toBe(200)
    expect(await count(t, "messages")).toBe(0)
    expect((await sync(t, mac.token)).messages.map((m) => m.ref)).not.toContain(late.id)
  })
})

describe("migration to the network", () => {
  test("owner, active senders and open invites move once; a second run changes nothing", async () => {
    const t = setup()
    // Without OWNER_EMAIL, or before the owner signed in: a clean error, no writes.
    expect(await t.mutation(internal.migrations.migrateToNetwork, {})).toEqual({ ok: false, error: "no-owner-email" })
    process.env.OWNER_EMAIL = OWNER
    expect(await t.mutation(internal.migrations.migrateToNetwork, {})).toEqual({ ok: false, error: "owner-not-signed-in" })
    expect(await count(t, "users")).toBe(0)
    // The owner may always get a code.
    expect(await t.query(api.invites.check, { email: "Owner@Example.com" })).toBe(true)

    // v2 state: two people in through the owner's Mac, one pending link, one revoked person, one agent.
    const legacy = async (name: string, email: string) => {
      const res = await post(t, "/mac/invite-link", { name }, { Authorization: `Bearer ${MAC}` })
      const { url, senderId } = (await res.json()) as { url: string; senderId: string }
      const token = new URL(url).searchParams.get("i")!
      await t.mutation(api.inviteLinks.start, { token, email })
      const userId = await t.run((ctx) => ctx.db.insert("users", { email }))
      const as = t.withIdentity({ subject: `${userId}|s` })
      expect(await as.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: true, name })
      return { userId: userId as string, senderId, as }
    }
    const A = await legacy("Anna", "anna@example.com")
    const B = await legacy("Bara", "bara@example.com")
    const gone = await legacy("Gone", "gone@example.com")
    await post(t, "/mac/sender-revoke", { senderId: gone.senderId }, { Authorization: `Bearer ${MAC}` })
    const pendingRes = await post(t, "/mac/invite-link", { name: "Pending" }, { Authorization: `Bearer ${MAC}` })
    const pending = (await pendingRes.json()) as { url: string; senderId: string }
    const pendingToken = new URL(pending.url).searchParams.get("i")!
    await post(t, "/mac/agent-key", { name: "Bot", keyHash: sha256Hex("uk_bot_key_for_tests_only_000000"), keyTail: "0000" }, { Authorization: `Bearer ${MAC}` })
    // Signed-in v2 members are members already, with no contacts yet.
    expect(await A.as.query(api.senders.me, {})).toMatchObject({ status: "member", name: "Anna", userId: A.userId })

    const ownerId = await t.run((ctx) => ctx.db.insert("users", { email: OWNER }))
    const first = await t.mutation(internal.migrations.migrateToNetwork, { ownerName: "Dominik" })
    expect(first).toEqual({ ok: true, ownerId, members: 1, contacts: 2, invites: 1 })
    const O = t.withIdentity({ subject: `${ownerId}|s` })
    expect(await O.query(api.senders.me, {})).toEqual({ status: "member", name: "Dominik", userId: ownerId, onboarded: false })
    const oList = await O.query(api.contacts.list, {})
    expect(oList.status === "member" && oList.contacts.map((c) => c.name)).toEqual(["Anna", "Bara"])
    expect(await A.as.query(api.senders.me, {})).toMatchObject({ status: "member", inviterName: "Dominik" })
    expect(await gone.as.query(api.senders.me, {})).toMatchObject({ status: "notMember" })
    expect(await O.query(api.inviteLinks.mine, {})).toEqual([
      { inviteId: expect.any(String), name: "Pending", email: null, createdAt: expect.any(Number), expiresAt: expect.any(Number) },
    ])
    expect(await t.query(api.inviteLinks.check, { token: pendingToken })).toEqual({ ok: true, name: "Pending", inviterName: "Dominik" })

    const tables = ["users", "contacts", "senders", "inviteLinks", "invites", "devices", "messages"] as const
    const snapshot = async () => Promise.all(tables.map((x) => count(t, x)))
    const counts = await snapshot()
    const dump = await t.run(async (ctx) => JSON.stringify([await ctx.db.query("users").collect(), await ctx.db.query("inviteLinks").collect()]))
    expect(await t.mutation(internal.migrations.migrateToNetwork, { ownerName: "Someone else" })).toEqual({ ok: true, ownerId, members: 0, contacts: 0, invites: 0 })
    expect(await snapshot()).toEqual(counts)
    expect(await t.run(async (ctx) => JSON.stringify([await ctx.db.query("users").collect(), await ctx.db.query("inviteLinks").collect()]))).toBe(dump)

    // The moved link joins the network: contact with the owner, the waiting v2 sender is gone.
    await t.mutation(api.inviteLinks.start, { token: pendingToken, email: "pending@example.com" })
    const pId = await t.run((ctx) => ctx.db.insert("users", { email: "pending@example.com" }))
    const P = t.withIdentity({ subject: `${pId}|s` })
    expect(await P.mutation(api.inviteLinks.claim, { token: pendingToken })).toEqual({ ok: true, name: "Pending" })
    expect(await t.run((ctx) => ctx.db.get(pending.senderId as Id<"senders">))).toBeNull()
    expect(await P.query(api.senders.me, {})).toEqual({ status: "member", name: "Pending", userId: pId, onboarded: false, inviterName: "Dominik" })
    const pList = await P.query(api.contacts.list, {})
    expect(pList.status === "member" && pList.contacts.map((c) => c.userId)).toEqual([ownerId])

    // Revoking a v2 person over MAC_TOKEN also takes them out of the network, with their undelivered pings.
    const aMac = await pairMac(t, A.as, "Annin Mac")
    const oMac = await pairMac(t, O, "Dominikův Mac")
    const aRef = newRef()
    expect(await devJson(t, aMac.token, "POST", "/device/send", { ref: aRef, to: ownerId, envelopes: seal([oMac.deviceId]) })).toEqual({ ok: true, ref: aRef })
    const toA = newRef()
    expect(await devJson(t, oMac.token, "POST", "/device/send", { ref: toA, to: A.userId, envelopes: seal([aMac.deviceId]) })).toEqual({ ok: true, ref: toA })
    expect(await count(t, "messages")).toBe(2)
    expect((await post(t, "/mac/sender-revoke", { senderId: A.senderId }, { Authorization: `Bearer ${MAC}` })).status).toBe(200)
    expect(await A.as.query(api.senders.me, {})).toEqual({ status: "notMember", email: "anna@example.com" })
    expect(await devJson(t, aMac.token, "GET", "/device/me", undefined, 401)).toEqual({ ok: false, error: "unauthorized" })
    const oAfter = await O.query(api.contacts.list, {})
    expect(oAfter.status === "member" && oAfter.contacts.map((c) => c.name)).toEqual(["Bara", "Pending"])
    expect(await count(t, "messages")).toBe(0)
    expect((await sync(t, oMac.token)).messages).toEqual([])
    void B
  })
})

describe("network cleanup", () => {
  test("expired messages, pairing requests and rate windows go; fresh ones stay", async () => {
    const t = setup()
    const { D, V, dMac } = await network(t)
    const ref = newRef()
    await V.as.mutation(api.messages.send, { ref, to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId]), titleEnvelopes: [] })
    const fresh = newRef()
    await V.as.mutation(api.messages.send, { ref: fresh, to: D.userId, forAgent: false, urgency: "green", envelopes: seal([dMac.deviceId]), titleEnvelopes: [] })
    await t.run(async (ctx) => {
      const m = await ctx.db.query("messages").withIndex("by_ref", (q) => q.eq("ref", ref)).first()
      await ctx.db.patch(m!._id, { expiresAt: Date.now() - 1 })
      for (const r of await ctx.db.query("rateLimits").collect()) await ctx.db.patch(r._id, { expiresAt: Date.now() - 1 })
    })
    const pairs = await count(t, "pairRequests")
    const limits = await count(t, "rateLimits")
    expect(await t.mutation(internal.cleanup.network, {})).toEqual({ messages: 1, pairRequests: 0, rateLimits: limits })
    // Each paired Mac's request stays (with its sealed token) until its 10 minutes are up.
    expect(pairs).toBe(3)
    expect((await sync(t, dMac.token)).messages.map((m) => m.ref)).toEqual([fresh])
    expect(await t.mutation(internal.cleanup.network, {})).toEqual({ messages: 0, pairRequests: 0, rateLimits: 0 })
  })
})
