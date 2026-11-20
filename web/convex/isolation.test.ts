// @vitest-environment edge-runtime
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { DAY, HOUR, sha256Hex } from "./model"
import schema from "./schema"

const modules = import.meta.glob("./**/*.*s")
const MAC = "mac-token-used-only-in-tests"

beforeEach(() => {
  process.env.MAC_TOKEN = MAC
  delete process.env.APP_PIN
  delete process.env.WEB_URL
})

afterEach(() => {
  vi.useRealTimers()
})

type T = ReturnType<typeof convexTest>
type As = ReturnType<T["withIdentity"]>

function setup() {
  return convexTest(schema, modules)
}

function macPost(t: T, path: string, body: unknown) {
  return t.fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${MAC}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function macSync(t: T, body: Record<string, unknown>) {
  const res = await macPost(t, "/mac/sync", { ack: [], ...body })
  expect(res.status).toBe(200)
  return (await res.json()) as { now: number; watching: boolean; commands: Record<string, unknown>[] }
}

/** The whole invite flow: Mac makes a link, the person enters an email, signs in, claims. */
async function invitePerson(t: T, name: string, email: string) {
  const res = await macPost(t, "/mac/invite-link", { name })
  expect(res.status).toBe(200)
  const { senderId, url, expiresAt } = (await res.json()) as { senderId: string; url: string; expiresAt: number }
  expect(url.startsWith("https://pingme.macaly.app/?i=")).toBe(true)
  expect(expiresAt).toBeGreaterThan(Date.now() + 6 * DAY)
  const token = new URL(url).searchParams.get("i")!
  expect(await t.query(api.inviteLinks.check, { token })).toEqual({ ok: true, name })
  expect(await t.mutation(api.inviteLinks.start, { token, email })).toEqual({ ok: true })
  expect(await t.query(api.invites.check, { email })).toBe(true)
  // Convex Auth creates the user after the email code.
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: email.toLowerCase() }))
  const as = t.withIdentity({ subject: `${userId}|session-${name}` })
  expect(await as.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: true, name })
  return { as, userId, senderId, token }
}

async function newAgent(t: T, name: string) {
  const key = `uk_${crypto.randomUUID().replace(/-/g, "")}`
  const res = await macPost(t, "/mac/agent-key", { name, keyHash: sha256Hex(key), keyTail: key.slice(-4) })
  expect(res.status).toBe(200)
  const { senderId } = (await res.json()) as { senderId: string }
  return { key, senderId }
}

let rpcId = 0
function mcp(t: T, key: string, body: unknown) {
  return t.fetch("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

type ToolResult = { content: { type: string; text: string }[]; structuredContent: any; isError?: boolean }

async function tool(t: T, key: string, name: string, args: Record<string, unknown>) {
  const res = await mcp(t, key, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { result: ToolResult }
  expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
  return body.result
}

function snapTask(id: string, title: string, extra: Record<string, unknown> = {}) {
  const now = Date.now()
  return { id, title, dueAt: now, showAt: now, byName: "x", source: "web", snoozeCount: 0, ...extra }
}

describe("sha256Hex", () => {
  test("matches the standard vectors and WebCrypto", async () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    const inputs = ["Žluťoučký kůň", "a".repeat(55), "b".repeat(56), "c".repeat(64), "d".repeat(1000), `uk_${"x".repeat(43)}`]
    for (const input of inputs) {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
      expect(sha256Hex(input)).toBe(hex)
    }
  })
})

describe("isolation between senders", () => {
  test("persons and agents see only their own tasks, statuses and replies", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    const B = await invitePerson(t, "Bara", "Bara@Example.com")
    const C = await newAgent(t, "Claude Code")
    const D = await newAgent(t, "Other agent")

    const now = Date.now()
    const a = await A.as.mutation(api.relay.create, { title: "A-title-apple", dueAt: now, urgency: "red" })
    const b = await B.as.mutation(api.relay.create, { title: "B-title-banana", dueAt: now })
    const c = await tool(t, C.key, "pingme", { title: "C-title-cherry", urgency: "orange" })
    if (!a.ok || !b.ok) throw new Error("create failed")
    const aRef = a.id
    const bRef = b.id
    const cRef = c.structuredContent.id as string
    expect(c.isError).toBeUndefined()
    expect(c.structuredContent).toEqual({ id: cRef, status: "queued" })

    // Before the Mac picks them up, each sender sees only its own queued command.
    const queuedA = await A.as.query(api.relay.state, {})
    if (queuedA.status !== "member") throw new Error("A not member")
    expect(queuedA.queued.map((q) => q.id)).toEqual([aRef])
    const mineB0 = await B.as.query(api.tasks.mine, {})
    if (mineB0.status !== "member") throw new Error("B not member")
    expect(mineB0.rows.map((r) => [r.taskRef, r.status, r.title, r.urgency])).toEqual([
      [bRef, "queued", "B-title-banana", "green"],
    ])

    // The Mac's live feed carries all three with their sender.
    const feed = await t.query(api.macFeed.get, { key: MAC })
    if (!feed.ok) throw new Error("feed failed")
    expect(feed.webLastSeen).toBeNull()
    expect(feed.commands.map((x) => [x.id, x.senderId, x.senderKind, x.urgency, x.byName])).toEqual([
      [aRef, A.senderId, "person", "red", "Anna"],
      [bRef, B.senderId, "person", "green", "Bara"],
      [cRef, C.senderId, "agent", "orange", "Claude Code"],
    ])

    // A has the page open, so the Mac shares its list; then it reports replies.
    expect(await A.as.mutation(api.relay.ping, {})).toBe(true)
    const synced = await macSync(t, {
      ack: [aRef, bRef, cRef],
      tasks: [
        snapTask(aRef, "A-title-apple", { senderId: A.senderId, senderKind: "person", urgency: "red", taskRef: aRef, reply: "A-snap-reply-avocado" }),
        snapTask(bRef, "B-title-banana", { senderId: B.senderId, senderKind: "person", taskRef: bRef, reply: "B-snap-reply-beet" }),
        snapTask(cRef, "C-title-cherry", { senderId: C.senderId, senderKind: "agent", urgency: "orange", taskRef: cRef }),
        snapTask("owner-1", "OWNER-title-secret", { source: "mac" }),
      ],
      statuses: [
        { taskRef: aRef, status: "replied", at: now + 1000, reply: "A-reply-anchovy" },
        { taskRef: bRef, status: "replied", at: now + 1000, reply: "B-reply-broccoli" },
        { taskRef: cRef, status: "replied", at: now + 1000, reply: "C-reply-carrot" },
        { taskRef: "owner-1", status: "popped", at: now + 1000 },
      ],
    })
    expect(synced.watching).toBe(true)
    expect(synced.commands).toEqual([])
    const feedAfter = await t.query(api.macFeed.get, { key: MAC })
    expect(feedAfter.ok && feedAfter.webLastSeen).toBeGreaterThan(0)

    const foreignToA = [bRef, cRef, "B-title", "C-title", "B-reply", "C-reply", "B-snap", "OWNER", B.senderId, C.senderId]
    const foreignToB = [aRef, cRef, "A-title", "C-title", "A-reply", "C-reply", "A-snap", "OWNER", A.senderId, C.senderId]

    // Positive control: A sees its own title and reply.
    const mineA = await A.as.query(api.tasks.mine, {})
    if (mineA.status !== "member") throw new Error("A not member")
    expect(mineA.name).toBe("Anna")
    expect(mineA.snapshotAt).not.toBeNull()
    expect(mineA.rows).toHaveLength(1)
    expect(mineA.rows[0]).toMatchObject({
      taskRef: aRef,
      title: "A-title-apple",
      urgency: "red",
      status: "replied",
      reply: "A-reply-anchovy",
      replyPending: true,
    })
    for (const s of foreignToA) expect(JSON.stringify(mineA)).not.toContain(s)

    const stateA = await A.as.query(api.relay.state, {})
    if (stateA.status !== "member") throw new Error("A not member")
    expect(stateA.snapshot?.tasks.map((x) => x.id)).toEqual([aRef])
    expect(stateA.queued).toEqual([])
    for (const s of foreignToA) expect(JSON.stringify(stateA)).not.toContain(s)

    const mineB = await B.as.query(api.tasks.mine, {})
    if (mineB.status !== "member") throw new Error("B not member")
    expect(mineB.rows.map((r) => [r.taskRef, r.title, r.reply])).toEqual([[bRef, "B-title-banana", "B-reply-broccoli"]])
    for (const s of foreignToB) expect(JSON.stringify(mineB)).not.toContain(s)
    const stateB = await B.as.query(api.relay.state, {})
    for (const s of foreignToB) expect(JSON.stringify(stateB)).not.toContain(s)
    if (stateB.status !== "member") throw new Error("B not member")
    expect(stateB.snapshot?.tasks.map((x) => x.id)).toEqual([bRef])

    // A cannot ack, finish or remove B's task.
    expect(await A.as.mutation(api.tasks.ackReply, { taskRef: bRef })).toBe(false)
    const b2 = await B.as.mutation(api.relay.create, { title: "B-second-blueberry", dueAt: now })
    if (!b2.ok) throw new Error("create failed")
    const countCommands = () => t.run(async (ctx) => (await ctx.db.query("commands").collect()).length)
    const before = await countCommands()
    for (const taskId of [bRef, b2.id, cRef]) {
      expect(await A.as.mutation(api.relay.markDone, { taskId })).toBe(false)
      expect(await A.as.mutation(api.relay.remove, { taskId })).toBe(false)
    }
    expect(await countCommands()).toBe(before)
    const bStatus = await t.run((ctx) =>
      ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", bRef)).first(),
    )
    expect(bStatus?.reply).toBe("B-reply-broccoli")
    expect(await t.run((ctx) => ctx.db.get(b2.id as Id<"commands">))).not.toBeNull()

    // B can take back its own queued task, but not one the Mac already has.
    expect(await B.as.mutation(api.relay.markDone, { taskId: bRef })).toBe(false)
    expect(await countCommands()).toBe(before)
    expect(await B.as.mutation(api.relay.remove, { taskId: b2.id })).toBe(true)
    expect(await countCommands()).toBe(before - 1)
    const b2Status = await t.run((ctx) =>
      ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", b2.id)).first(),
    )
    expect(b2Status).toBeNull()

    // A acks its own reply: the pending text goes, the Mac's copy in the snapshot stays visible.
    expect(await A.as.mutation(api.tasks.ackReply, { taskRef: aRef })).toBe(true)
    const mineA2 = await A.as.query(api.tasks.mine, {})
    if (mineA2.status !== "member") throw new Error("A not member")
    expect(mineA2.rows[0]).toMatchObject({ reply: "A-snap-reply-avocado", replyPending: false })

    // Agents: someone else's id answers exactly like an unknown one.
    const unknownStatus = await tool(t, C.key, "get_status", { id: "does-not-exist" })
    expect(unknownStatus).toMatchObject({ isError: true, structuredContent: { error: "not found" } })
    expect(await tool(t, C.key, "get_status", { id: aRef })).toEqual(unknownStatus)
    expect(await tool(t, C.key, "get_reply", { id: aRef })).toEqual(unknownStatus)
    expect(await tool(t, C.key, "get_status", {})).toEqual(unknownStatus)
    expect(await tool(t, D.key, "get_status", { id: cRef })).toEqual(unknownStatus)
    expect(await tool(t, D.key, "get_reply", { id: cRef })).toEqual(unknownStatus)
    expect(await tool(t, D.key, "get_status", { id: aRef })).toEqual(unknownStatus)
    const aStatus = await t.run((ctx) =>
      ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", aRef)).first(),
    )
    expect(aStatus?.status).toBe("replied")
    const cStillHasReply = await t.run((ctx) =>
      ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", cRef)).first(),
    )
    expect(cStillHasReply?.reply).toBe("C-reply-carrot")

    // C reads its own.
    const cStatus = await tool(t, C.key, "get_status", { id: cRef })
    expect(cStatus.structuredContent).toEqual({ status: "replied", at: now + 1000, snoozed_until: null, typing: false })
    const cReply = await tool(t, C.key, "get_reply", { id: cRef })
    expect(cReply.structuredContent).toEqual({ reply: "C-reply-carrot", at: now + 1000 })
    expect((await tool(t, C.key, "get_reply", { id: cRef })).structuredContent).toEqual({ reply: null })

    // Persons never get agent rows either way round.
    const mineAgentTask = await A.as.query(api.tasks.mine, {})
    expect(JSON.stringify(mineAgentTask)).not.toContain("C-title")

    // Revoked agent key: 401 on the next call.
    const revoke = await macPost(t, "/mac/sender-revoke", { senderId: C.senderId })
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ ok: true })
    const after = await mcp(t, C.key, { jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ error: "unauthorized" })

    // Revoked person: out at once, its statuses gone, its email off the code allowlist.
    expect((await macPost(t, "/mac/sender-revoke", { senderId: B.senderId })).status).toBe(200)
    expect(await B.as.query(api.senders.me, {})).toEqual({ status: "notMember", email: "bara@example.com" })
    expect(await B.as.query(api.tasks.mine, {})).toEqual({ status: "notMember" })
    expect(await B.as.query(api.relay.state, {})).toEqual({ status: "notInvited", email: "bara@example.com" })
    expect(await t.query(api.invites.check, { email: "bara@example.com" })).toBe(false)
    const bLeft = await t.run(async (ctx) =>
      ctx.db.query("taskStatus").withIndex("by_senderId", (q) => q.eq("senderId", B.senderId as Id<"senders">)).collect(),
    )
    expect(bLeft).toEqual([])
    // A is untouched.
    expect(await A.as.query(api.senders.me, {})).toEqual({ status: "member", name: "Anna", email: "anna@example.com", userId: A.userId, senderId: A.senderId, onboarded: false })
  })

  test("an email invite without a sender is never a member", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    const aTask = await A.as.mutation(api.relay.create, { title: "A-title", dueAt: Date.now() })
    if (!aTask.ok) throw new Error("create failed")
    const userId = await t.run(async (ctx) => {
      await ctx.db.insert("invites", { email: "viki@example.com", name: "Viki", createdAt: Date.now() })
      return await ctx.db.insert("users", { email: "viki@example.com" })
    })
    const old = t.withIdentity({ subject: `${userId}|old-session` })
    expect(await old.query(api.senders.me, {})).toEqual({ status: "notMember", email: "viki@example.com" })
    expect(await old.query(api.tasks.mine, {})).toEqual({ status: "notMember" })
    expect(await old.query(api.relay.state, {})).toEqual({ status: "notInvited", email: "viki@example.com" })
    expect(await old.mutation(api.relay.create, { title: "x", dueAt: Date.now() })).toEqual({
      ok: false,
      error: "not-member",
    })
    expect(await old.mutation(api.relay.ping, {})).toBe(false)
    expect(await old.mutation(api.tasks.ackReply, { taskRef: aTask.id })).toBe(false)
    expect(await old.mutation(api.relay.remove, { taskId: aTask.id })).toBe(false)

    // Signed out entirely.
    expect(await t.query(api.senders.me, {})).toEqual({ status: "signedOut" })
    expect(await t.query(api.tasks.mine, {})).toEqual({ status: "signedOut" })
    expect(await t.query(api.relay.state, {})).toEqual({ status: "signedOut" })
    expect(await t.mutation(api.tasks.ackReply, { taskRef: aTask.id })).toBe(false)

    // The one-time migration turns the v1 invite into an active sender.
    expect(await t.mutation(internal.senders.adoptInvite, { email: "Viki@example.com" })).toMatchObject({ ok: true })
    expect(await old.query(api.senders.me, {})).toMatchObject({ status: "member", name: "Viki" })
    const mine = await old.query(api.tasks.mine, {})
    expect(mine.status === "member" && mine.rows).toEqual([])
  })

  test("the PIN path is closed: old and bogus tokens are signed out, login says not-set", async () => {
    const t = setup()
    process.env.APP_PIN = "1234"
    const A = await invitePerson(t, "Anna", "anna@example.com")
    await A.as.mutation(api.relay.create, { title: "A-title", dueAt: Date.now() })
    await t.run((ctx) => ctx.db.insert("pinSessions", { token: "legacy-token", name: "Viki", createdAt: Date.now() }))
    for (const token of ["legacy-token", "bogus", ""]) {
      expect(await t.query(api.relay.state, { token })).toEqual({ status: "signedOut" })
      expect(await t.mutation(api.relay.ping, { token })).toBe(false)
      expect(await t.mutation(api.relay.create, { title: "x", dueAt: Date.now(), token })).toEqual({
        ok: false,
        error: "not-member",
      })
      expect(await t.mutation(api.relay.markDone, { taskId: "x", token })).toBe(false)
    }
    // Even a signed-in member passing a token gets nothing on that path.
    expect(await A.as.query(api.relay.state, { token: "legacy-token" })).toEqual({ status: "signedOut" })
    expect(await t.mutation(api.pin.login, { pin: "1234", name: "Viki" })).toEqual({ ok: false, error: "not-set" })
    expect(await t.run(async (ctx) => (await ctx.db.query("pinSessions").collect()).length)).toBe(1)
    expect(await t.mutation(internal.cleanup.dropPinSessions, {})).toBe(1)
  })

  test("macFeed.get and the Mac routes need MAC_TOKEN", async () => {
    const t = setup()
    expect(await t.query(api.macFeed.get, { key: "wrong" })).toEqual({ ok: false })
    expect(await t.query(api.macFeed.get, { key: "" })).toEqual({ ok: false })
    expect(await t.query(api.macFeed.get, { key: `${MAC}x` })).toEqual({ ok: false })
    expect(await t.query(api.macFeed.get, { key: MAC })).toEqual({ ok: true, commands: [], webLastSeen: null })
    delete process.env.MAC_TOKEN
    expect(await t.query(api.macFeed.get, { key: "" })).toEqual({ ok: false })
    process.env.MAC_TOKEN = MAC
    for (const [path, method] of [
      ["/mac/sync", "POST"],
      ["/mac/invite-link", "POST"],
      ["/mac/agent-key", "POST"],
      ["/mac/senders", "GET"],
      ["/mac/sender-revoke", "POST"],
    ]) {
      const res = await t.fetch(path, { method, headers: { Authorization: "Bearer wrong" }, body: method === "POST" ? "{}" : undefined })
      expect(res.status).toBe(401)
    }
  })
})

describe("invite links", () => {
  test("start and claim: happy path, wrong email, reuse, expiry", async () => {
    const t = setup()
    process.env.WEB_URL = "https://example.test/"
    const res = await macPost(t, "/mac/invite-link", { name: "Franta" })
    const { url, senderId } = (await res.json()) as { url: string; senderId: string }
    expect(url.startsWith("https://example.test/?i=")).toBe(true)
    const token = new URL(url).searchParams.get("i")!
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(await t.query(api.inviteLinks.check, { token: "nonsense" })).toEqual({ ok: false })
    expect(await t.mutation(api.inviteLinks.start, { token: "nonsense", email: "f@example.com" })).toEqual({
      ok: false,
      error: "bad-link",
    })
    expect(await t.mutation(api.inviteLinks.start, { token, email: "not-an-email" })).toEqual({
      ok: false,
      error: "bad-email",
    })
    expect(await t.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: false, error: "signed-out" })
    expect(await t.mutation(api.inviteLinks.start, { token, email: " Franta@Example.com " })).toEqual({ ok: true })

    // Someone else signed in with another email cannot take the link.
    const otherUser = await t.run((ctx) => ctx.db.insert("users", { email: "other@example.com" }))
    const other = t.withIdentity({ subject: `${otherUser}|s` })
    expect(await other.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: false, error: "wrong-email" })
    expect(await other.query(api.senders.me, {})).toEqual({ status: "notMember", email: "other@example.com" })

    // The right person can.
    const user = await t.run((ctx) => ctx.db.insert("users", { email: "franta@example.com" }))
    const franta = t.withIdentity({ subject: `${user}|s` })
    expect(await franta.query(api.senders.me, {})).toEqual({ status: "notMember", email: "franta@example.com" })
    expect(await franta.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: true, name: "Franta" })
    expect(await franta.query(api.senders.me, {})).toEqual({ status: "member", name: "Franta", email: "franta@example.com", userId: user, senderId, onboarded: false })
    // The intro shows once per account: after it, every browser of this account skips it.
    await franta.mutation(api.senders.finishOnboarding, {})
    expect(await franta.query(api.senders.me, {})).toMatchObject({ onboarded: true })
    const firstAt = (await t.run((ctx) => ctx.db.get(user)))?.onboardedAt
    await franta.mutation(api.senders.finishOnboarding, {})
    expect((await t.run((ctx) => ctx.db.get(user)))?.onboardedAt).toBe(firstAt)

    // A used link is dead everywhere.
    expect(await t.query(api.inviteLinks.check, { token })).toEqual({ ok: false })
    expect(await t.mutation(api.inviteLinks.start, { token, email: "x@example.com" })).toEqual({
      ok: false,
      error: "bad-link",
    })
    expect(await franta.mutation(api.inviteLinks.claim, { token })).toEqual({ ok: false, error: "bad-link" })

    // A second link for someone who is already in: claim keeps the old sender and drops the new one.
    const res2 = await macPost(t, "/mac/invite-link", { name: "Franta 2" })
    const second = (await res2.json()) as { url: string; senderId: string }
    const token2 = new URL(second.url).searchParams.get("i")!
    await t.mutation(api.inviteLinks.start, { token: token2, email: "franta@example.com" })
    expect(await franta.mutation(api.inviteLinks.claim, { token: token2 })).toEqual({ ok: true, name: "Franta" })
    expect(await t.run((ctx) => ctx.db.get(second.senderId as Id<"senders">))).toBeNull()

    // Expired link.
    const res3 = await macPost(t, "/mac/invite-link", { name: "Late" })
    const third = (await res3.json()) as { url: string }
    const token3 = new URL(third.url).searchParams.get("i")!
    await t.run(async (ctx) => {
      const link = await ctx.db
        .query("inviteLinks")
        .withIndex("by_tokenHash", (q) => q.eq("tokenHash", sha256Hex(token3)))
        .first()
      await ctx.db.patch(link!._id, { expiresAt: Date.now() - 1 })
    })
    expect(await t.query(api.inviteLinks.check, { token: token3 })).toEqual({ ok: false })

    // Bad names are refused.
    expect((await macPost(t, "/mac/invite-link", { name: "" })).status).toBe(400)
    expect((await macPost(t, "/mac/invite-link", { name: "x".repeat(61) })).status).toBe(400)
  })

  test("the owner's list shows people, invitations and agents, not revoked ones", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    await macPost(t, "/mac/invite-link", { name: "Pending" })
    const C = await newAgent(t, "Bot")
    const gone = await newAgent(t, "Gone")
    await macPost(t, "/mac/sender-revoke", { senderId: gone.senderId })

    const res = await t.fetch("/mac/senders", { headers: { Authorization: `Bearer ${MAC}` } })
    const { senders } = (await res.json()) as { senders: Record<string, unknown>[] }
    const byName = Object.fromEntries(senders.map((s) => [s.name, s]))
    expect(Object.keys(byName).sort()).toEqual(["Anna", "Bot", "Pending"])
    expect(byName.Anna).toMatchObject({ id: A.senderId, kind: "person", status: "active", email: "anna@example.com" })
    expect(byName.Pending).toMatchObject({ kind: "person", status: "invited" })
    expect(byName.Pending.inviteExpiresAt).toBeGreaterThan(Date.now())
    expect(byName.Bot).toMatchObject({ id: C.senderId, kind: "agent", status: "active", keyTail: C.key.slice(-4) })
    expect(JSON.stringify(senders)).not.toContain("keyHash")

    // Same key twice: 409. Bad hash: 400.
    const dup = await macPost(t, "/mac/agent-key", { name: "Again", keyHash: sha256Hex(C.key).toUpperCase(), keyTail: "abcd" })
    expect(dup.status).toBe(409)
    expect((await macPost(t, "/mac/agent-key", { name: "X", keyHash: "abc", keyTail: "abcd" })).status).toBe(400)
    expect((await macPost(t, "/mac/sender-revoke", { senderId: "nope" })).status).toBe(404)
  })
})

describe("MCP", () => {
  test("protocol shapes", async () => {
    const t = setup()
    const C = await newAgent(t, "Claude Code")

    expect((await t.fetch("/mcp", { method: "POST", body: "{}" })).status).toBe(401)
    const wrong = await mcp(t, "uk_wrong", { jsonrpc: "2.0", id: 1, method: "ping" })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: "unauthorized" })
    expect((await t.fetch("/mcp", { method: "GET" })).status).toBe(405)
    expect((await t.fetch("/mcp", { method: "DELETE", headers: { Authorization: `Bearer ${C.key}` } })).status).toBe(405)

    const init = await mcp(t, C.key, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    })
    expect(init.status).toBe(200)
    expect(init.headers.get("Content-Type")).toBe("application/json")
    expect(await init.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "pingme", version: "2.0.0" },
        instructions: "Use pingme to send Dominik a task that pops up on his Mac. Use urgency red only when it cannot wait.",
      },
    })
    const initNew = await mcp(t, C.key, { jsonrpc: "2.0", id: "x", method: "initialize", params: { protocolVersion: "2099-01-01" } })
    expect(((await initNew.json()) as any).result.protocolVersion).toBe("2025-06-18")

    const note = await mcp(t, C.key, { jsonrpc: "2.0", method: "notifications/initialized" })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe("")

    expect(await (await mcp(t, C.key, { jsonrpc: "2.0", id: 2, method: "ping" })).json()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: {},
    })

    const list = (await (await mcp(t, C.key, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as any
    expect(list.result.tools.map((x: any) => x.name)).toEqual(["pingme", "get_status", "get_reply"])
    for (const x of list.result.tools) expect(x.inputSchema.type).toBe("object")
    expect(list.result.tools[0].inputSchema.required).toEqual(["title"])
    expect(list.result.tools[0].inputSchema.properties.urgency.enum).toEqual(["green", "orange", "red"])

    const unknownMethod = await mcp(t, C.key, { jsonrpc: "2.0", id: 4, method: "resources/list" })
    expect(unknownMethod.status).toBe(200)
    expect(((await unknownMethod.json()) as any).error.code).toBe(-32601)

    const unknownTool = await mcp(t, C.key, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rm_rf" } })
    expect(((await unknownTool.json()) as any).error.code).toBe(-32602)

    const batch = await mcp(t, C.key, [{ jsonrpc: "2.0", id: 6, method: "ping" }])
    expect(batch.status).toBe(400)
    expect(((await batch.json()) as any).error.code).toBe(-32600)

    const garbage = await mcp(t, C.key, "{not json")
    expect(garbage.status).toBe(400)
    expect(((await garbage.json()) as any).error.code).toBe(-32700)

    // tools/call results.
    const sent = await tool(t, C.key, "pingme", { title: "  Zkontroluj build  " })
    expect(sent.content[0].type).toBe("text")
    const id = sent.structuredContent.id as string
    const cmd = await t.run((ctx) => ctx.db.get(id as Id<"commands">))
    expect(cmd).toMatchObject({ kind: "create", title: "Zkontroluj build", urgency: "green", senderKind: "agent", byName: "Claude Code" })
    expect(Math.abs(cmd!.dueAt! - Date.now())).toBeLessThan(5000)
    expect((await tool(t, C.key, "get_status", { id })).structuredContent).toMatchObject({ status: "queued", typing: false })

    expect(await tool(t, C.key, "pingme", {})).toMatchObject({ isError: true, structuredContent: { error: "bad-title" } })
    expect(await tool(t, C.key, "pingme", { title: "x".repeat(201) })).toMatchObject({
      isError: true,
      structuredContent: { error: "bad-title" },
    })
    expect(await tool(t, C.key, "pingme", { title: "x", urgency: "purple" })).toMatchObject({
      isError: true,
      structuredContent: { error: "bad-urgency" },
    })
  })

  test("rate limit: the 31st message in an hour fails and inserts nothing", async () => {
    const t = setup()
    const C = await newAgent(t, "Spammy")
    for (let i = 0; i < 30; i++) {
      const r = await tool(t, C.key, "pingme", { title: `task ${i}` })
      expect(r.isError).toBeUndefined()
    }
    const count = () =>
      t.run(async (ctx) =>
        (await ctx.db.query("commands").withIndex("by_senderId", (q) => q.eq("senderId", C.senderId as Id<"senders">)).collect()).length,
      )
    expect(await count()).toBe(30)
    expect(await tool(t, C.key, "pingme", { title: "one too many" })).toMatchObject({
      isError: true,
      structuredContent: { error: "rate-limited" },
    })
    expect(await count()).toBe(30)
    const sender = await t.run((ctx) => ctx.db.get(C.senderId as Id<"senders">))
    expect(sender?.lastUsedAt).toBeGreaterThan(0)

    // A new hour opens the window again.
    await t.run((ctx) => ctx.db.patch(C.senderId as Id<"senders">, { rateWindowStart: Date.now() - HOUR - 1 }))
    expect((await tool(t, C.key, "pingme", { title: "next hour" })).isError).toBeUndefined()
  })
})

describe("statuses from the Mac", () => {
  test("outbox rules: older statuses are ignored, snooze, typing, done expiry, junk is skipped", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    const C = await newAgent(t, "Bot")
    const created = await A.as.mutation(api.relay.create, { title: "Vynes koš", dueAt: Date.now(), urgency: "orange" })
    if (!created.ok) throw new Error("create failed")
    const ref = created.id
    const row = () =>
      t.run((ctx) => ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", ref)).first())

    // The Mac clock is a bit behind the server: its first status still replaces "queued".
    const T = Date.now() - 5000
    await macSync(t, { ack: [ref], statuses: [{ taskRef: ref, status: "popped", at: T }] })
    expect(await row()).toMatchObject({ status: "popped", at: T })

    await macSync(t, { statuses: [{ taskRef: ref, status: "seen", at: T + 2000 }] })
    // A retried older status from the outbox does not go back.
    await macSync(t, { statuses: [{ taskRef: ref, status: "popped", at: T + 1000 }] })
    expect(await row()).toMatchObject({ status: "seen", at: T + 2000 })

    // Typing.
    await macSync(t, { typing: { taskRef: ref } })
    const typing = (await row())!.typingUntil!
    expect(typing).toBeGreaterThan(Date.now())
    const mine = await A.as.query(api.tasks.mine, {})
    expect(mine.status === "member" && mine.rows[0].typingUntil).toBe(typing)

    // Snooze, then popped again clears snoozedUntil.
    await macSync(t, { statuses: [{ taskRef: ref, status: "snoozed", at: T + 3000, snoozedUntil: T + 600_000 }] })
    expect(await row()).toMatchObject({ status: "snoozed", snoozedUntil: T + 600_000 })
    const mineSnoozed = await A.as.query(api.tasks.mine, {})
    expect(mineSnoozed.status === "member" && mineSnoozed.rows[0]).toMatchObject({ status: "snoozed", snoozedUntil: T + 600_000 })
    await macSync(t, { statuses: [{ taskRef: ref, status: "popped", at: T + 4000, snoozedUntil: 0 }] })
    expect((await row())!.snoozedUntil).toBeUndefined()

    // Reply clears typing and is kept until acked.
    await macSync(t, { typing: { taskRef: ref } })
    await macSync(t, { statuses: [{ taskRef: ref, status: "replied", at: T + 5000, reply: "  Jdu na to  " }] })
    expect(await row()).toMatchObject({ status: "replied", reply: "Jdu na to", replyAt: T + 5000 })
    expect((await row())!.typingUntil).toBeUndefined()

    // Done keeps the reply, and the reply keeps the row a month.
    await macSync(t, { statuses: [{ taskRef: ref, status: "done", at: T + 6000 }] })
    expect(await row()).toMatchObject({ status: "done", reply: "Jdu na to", expiresAt: T + 5000 + 30 * DAY })

    // ackReply clears it.
    expect(await A.as.mutation(api.tasks.ackReply, { taskRef: ref })).toBe(true)
    const acked = (await row())!
    expect(acked.reply).toBeUndefined()
    expect(acked.replyAt).toBeUndefined()

    // Junk in the outbox is skipped, never fails the sync; unknown taskRefs (owner tasks) are skipped.
    await macSync(t, {
      statuses: [
        { taskRef: 5, status: "done", at: T },
        { taskRef: ref, status: "exploded", at: T + 9000 },
        { taskRef: ref, status: "seen" },
        { taskRef: "owner-task", status: "popped", at: T + 9000 },
        "nonsense",
      ],
      typing: { taskRef: "owner-task" },
      tasks: [snapTask("t1", "x", { senderKind: "owner", urgency: "pink", reply: "r".repeat(500) })],
    })
    expect(await row()).toMatchObject({ status: "done", at: T + 6000 })

    // Agent sees typing through get_status.
    const sent = await tool(t, C.key, "send_message", { title: "ping" }) // old name still works
    const cRef = sent.structuredContent.id as string
    await macSync(t, { ack: [cRef], typing: { taskRef: cRef } })
    expect((await tool(t, C.key, "get_status", { id: cRef })).structuredContent).toMatchObject({ typing: true })
  })

  test("snapshot keeps v2 fields, trims replies and drops unknown values", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    await A.as.mutation(api.relay.ping, {})
    await macSync(t, {
      tasks: [
        snapTask("t1", "Repeat one", {
          senderId: A.senderId,
          senderKind: "owner",
          urgency: "pink",
          taskRef: "ref-1",
          reply: "r".repeat(500),
          replyAt: 1,
          seenAt: 2,
          snoozedUntil: 0,
          repeat: "daily",
          doneAt: Date.now() - 1000,
        }),
        snapTask("t2", "Repeat two", { senderId: A.senderId, taskRef: "ref-1", repeat: "daily", dueAt: Date.now() + 1000 }),
      ],
    })
    const snap = await t.run((ctx) => ctx.db.query("snapshot").first())
    const first = snap!.tasks[0]
    expect(first.senderKind).toBeUndefined()
    expect(first.urgency).toBeUndefined()
    expect(first.snoozedUntil).toBeUndefined()
    expect(first.reply).toHaveLength(200)
    expect(first).toMatchObject({ senderId: A.senderId, taskRef: "ref-1", replyAt: 1, seenAt: 2 })

    // Two rows share a taskRef (repeat): the open one wins.
    const mine = await A.as.query(api.tasks.mine, {})
    if (mine.status !== "member") throw new Error("not member")
    expect(mine.rows).toHaveLength(1)
    expect(mine.rows[0]).toMatchObject({ taskRef: "ref-1", title: "Repeat two", repeat: "daily", urgency: "green" })
  })
})

describe("messages for the agent", () => {
  test("to agent reaches the Mac once and now, the list keeps it, a bad value is refused", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    const later = Date.now() + DAY
    const res = await A.as.mutation(api.relay.create, {
      title: "Koukni na pozvánky",
      dueAt: later,
      repeat: "daily",
      followUpTitle: "x",
      followUpMinutes: 5,
      to: "agent",
    })
    if (!res.ok) throw new Error(res.error)
    const plain = await A.as.mutation(api.relay.create, { title: "Pro Dominika", dueAt: Date.now() })
    if (!plain.ok) throw new Error(plain.error)

    const feed = await t.query(api.macFeed.get, { key: MAC })
    if (!feed.ok) throw new Error("feed")
    const cmd = feed.commands.find((c) => c.id === res.id)!
    expect(cmd.to).toBe("agent")
    expect(cmd.repeat).toBeUndefined()
    expect(cmd.followUpTitle).toBeUndefined()
    expect(cmd.dueAt!).toBeLessThan(later - HOUR)
    expect(feed.commands.find((c) => c.id === plain.id)!.to).toBeUndefined()

    const mine = await A.as.query(api.tasks.mine, {})
    if (mine.status !== "member") throw new Error("not member")
    expect(mine.rows.find((r) => r.taskRef === res.id)!.to).toBe("agent")

    // The Mac's list keeps the marker; anything else is dropped. (The list is kept only while the web is open.)
    await A.as.mutation(api.relay.ping, {})
    await macSync(t, {
      ack: [res.id],
      tasks: [snapTask("t1", "Koukni na pozvánky", { senderId: A.senderId, taskRef: res.id, to: "agent" }), snapTask("t2", "Jiný", { to: "boss" })],
    })
    const snap = await t.run((ctx) => ctx.db.query("snapshot").first())
    expect(snap!.tasks[0].to).toBe("agent")
    expect(snap!.tasks[1].to).toBeUndefined()

    await expect(
      A.as.mutation(api.relay.create, { title: "x", dueAt: Date.now(), to: "boss" as "agent" }),
    ).rejects.toThrow()
  })
})

describe("cleanup cron", () => {
  test("deletes expired statuses, expired links with their unclaimed sender, and old commands", async () => {
    const t = setup()
    const now = Date.now()
    // First write of this test backend, so its creation time can be in the past.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(now - 61 * DAY)
    const oldCommand = await t.run((ctx) =>
      ctx.db.insert("commands", { kind: "create", title: "old", byName: "x", createdAt: Date.now() }),
    )
    vi.useRealTimers()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    const fresh = await A.as.mutation(api.relay.create, { title: "fresh", dueAt: now })
    if (!fresh.ok) throw new Error("create failed")

    const ids = await t.run(async (ctx) => {
      const sid = A.senderId as Id<"senders">
      const expired = await ctx.db.insert("taskStatus", { senderId: sid, taskRef: "old-ref", status: "done", at: now - 2 * DAY, expiresAt: now - DAY })
      const pending = await ctx.db.insert("senders", { kind: "person", name: "Never came", status: "invited", createdAt: now - 8 * DAY })
      const deadLink = await ctx.db.insert("inviteLinks", { tokenHash: "a".repeat(64), senderId: pending, expiresAt: now - 1 })
      return { expired, pending, deadLink }
    })

    const result = await t.mutation(internal.cleanup.run, {})
    expect(result).toMatchObject({ taskStatus: 1, senders: 1, commands: 1 })
    // Anna's claimed link has not expired yet, so only the dead one goes.
    expect(result.inviteLinks).toBe(1)
    await t.run(async (ctx) => {
      expect(await ctx.db.get(ids.expired)).toBeNull()
      expect(await ctx.db.get(ids.pending)).toBeNull()
      expect(await ctx.db.get(ids.deadLink)).toBeNull()
      expect(await ctx.db.get(oldCommand)).toBeNull()
      expect(await ctx.db.get(fresh.id as Id<"commands">)).not.toBeNull()
      const freshStatus = await ctx.db.query("taskStatus").withIndex("by_taskRef", (q) => q.eq("taskRef", fresh.id)).first()
      expect(freshStatus).not.toBeNull()
      expect(await ctx.db.get(A.senderId as Id<"senders">)).toMatchObject({ status: "active" })
    })
    // A second run finds nothing.
    expect(await t.mutation(internal.cleanup.run, {})).toEqual({ taskStatus: 0, inviteLinks: 0, senders: 0, commands: 0 })
  })
})

describe("old clients", () => {
  test("a v1 Mac sync (no new fields) still works and its tasks reach nobody", async () => {
    const t = setup()
    const A = await invitePerson(t, "Anna", "anna@example.com")
    await A.as.mutation(api.relay.ping, {})
    const res = await macSync(t, { ack: [], tasks: [snapTask("v1-task", "V1-secret")] })
    expect(res).toMatchObject({ watching: true, commands: [] })
    const mine = await A.as.query(api.tasks.mine, {})
    expect(JSON.stringify(mine)).not.toContain("V1-secret")
    const state = await A.as.query(api.relay.state, {})
    expect(JSON.stringify(state)).not.toContain("V1-secret")
  })
})

describe("crons", () => {
  test("hourly cleanup is registered next to the snapshot job", async () => {
    const crons = (await import("./crons")).default as unknown as { crons: Record<string, { name: string; schedule: unknown }> }
    expect(Object.keys(crons.crons).sort()).toEqual([
      "delete expired messages, pairing requests and rate limits",
      "delete expired statuses, invite links and old commands",
      "drop shared list when nobody watches",
    ])
    expect(crons.crons["delete expired statuses, invite links and old commands"].schedule).toMatchObject({ type: "interval", hours: 1 })
    // Every cron run is a billed backend call: nothing runs more often than hourly.
    expect(crons.crons["delete expired messages, pairing requests and rate limits"].schedule).toMatchObject({ type: "interval", hours: 1 })
    expect(crons.crons["drop shared list when nobody watches"].schedule).toMatchObject({ type: "interval", hours: 1 })
  })
})
