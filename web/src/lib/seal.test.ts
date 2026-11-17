import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import {
  aadFor,
  exportPrivateKey,
  fromB64,
  generateKeyPair,
  importPrivateKey,
  INFO,
  type Kind,
  newRef,
  open,
  openWithInfo,
  PAIR_INFO,
  pairTokenAad,
  publicKeyFor,
  seal,
  sealEnvelopes,
  sealWithInfo,
  SealError,
  toB64,
} from "./seal"

// Shared with `Pingme --selftest-crypto`. Tests only read it; see its _comment for regenerating.
type Vector = { kind: Kind; ref: string; from: string; to: string; plaintext: string; enc: string; ct: string }
type Vectors = {
  info: string
  keys: Record<"ts" | "swift", { publicKey: string; privateKey: string }>
  rfc9180: Record<"skRm" | "pkRm" | "info" | "enc" | "aad" | "pt" | "ct", string>
  fromTs: Vector[]
  fromSwift: Vector[]
}
// __dirname, not import.meta.url: under jsdom the module URL is not a file: URL.
const vectorsPath = resolve(__dirname, "../../../shared/hpke-vectors.json")
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as Vectors

// Same plaintexts the Swift side emits: plain, Czech diacritics with emoji, a reply, empty.
const samples: [Kind, string][] = [
  ["title", "Zavolej mi, až budeš mít chvilku."],
  ["title", "Příliš žluťoučký kůň úpěl ďábelské ódy 🐴"],
  ["reply", "Hotovo, díky!"],
  ["reply", ""],
]

const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => parseInt(b, 16)))
const flipFirstBit = (b64: string) => {
  const b = fromB64(b64)
  b[0] ^= 1
  return toB64(b)
}

describe("RFC 9180 A.2.1 known answer", () => {
  const r = vectors.rfc9180

  test("public key from private key", async () => {
    expect(await publicKeyFor(toB64(hex(r.skRm)))).toBe(toB64(hex(r.pkRm)))
  })

  test("opens sequence 0", async () => {
    const pt = await openWithInfo(hex(r.info), toB64(hex(r.skRm)), { enc: toB64(hex(r.enc)), ct: toB64(hex(r.ct)) }, hex(r.aad))
    // Array.from: under jsdom TextEncoder output is a Uint8Array from another realm.
    expect(Array.from(new TextEncoder().encode(pt))).toEqual(Array.from(hex(r.pt)))
  })
})

describe("shared vectors", () => {
  test("fixtures match this code", async () => {
    expect(vectors.info).toBe(INFO)
    expect(await publicKeyFor(vectors.keys.ts.privateKey)).toBe(vectors.keys.ts.publicKey)
    expect(await publicKeyFor(vectors.keys.swift.privateKey)).toBe(vectors.keys.swift.publicKey)
  })

  // fromSwift is the interop proof (CryptoKit sealed, we open). fromTs checks our own old output still opens.
  for (const [label, list, key, wrongKey] of [
    ["fromSwift", vectors.fromSwift, vectors.keys.ts.privateKey, vectors.keys.swift.privateKey],
    ["fromTs", vectors.fromTs, vectors.keys.swift.privateKey, vectors.keys.ts.privateKey],
  ] as const) {
    describe(label, () => {
      test("has both kinds", () => {
        expect(list.length).toBeGreaterThan(0)
        expect(new Set(list.map((v) => v.kind))).toEqual(new Set(["title", "reply"]))
      })

      list.forEach((v, i) => {
        const aad = aadFor(v)
        const sealed = { enc: v.enc, ct: v.ct }

        test(`[${i}] ${v.kind} opens`, async () => {
          expect(await open(key, sealed, aad)).toBe(v.plaintext)
        })

        test(`[${i}] wrong kind, swapped users, other ref and wrong key all fail`, async () => {
          const other: Kind = v.kind === "title" ? "reply" : "title"
          await expect(open(key, sealed, aadFor({ ...v, kind: other }))).rejects.toThrow(SealError)
          await expect(open(key, sealed, aadFor({ ...v, from: v.to, to: v.from }))).rejects.toThrow(SealError)
          await expect(open(key, sealed, aadFor({ ...v, ref: newRef() }))).rejects.toThrow(SealError)
          await expect(open(wrongKey, sealed, aad)).rejects.toThrow(SealError)
        })
      })
    })
  }
})

describe("seal and open", () => {
  const aad = aadFor({ kind: "title", ref: newRef(), from: "u_web_test", to: "u_mac_test" })

  test("round trip, including diacritics and empty text", async () => {
    const kp = await generateKeyPair()
    expect(fromB64(kp.publicKey)).toHaveLength(32)
    expect(fromB64(kp.privateKey)).toHaveLength(32)
    expect(await publicKeyFor(kp.privateKey)).toBe(kp.publicKey)
    for (const [, text] of samples) {
      expect(await open(kp.privateKey, await seal(kp.publicKey, text, aad), aad)).toBe(text)
    }
  })

  test("same text seals differently each time", async () => {
    const kp = await generateKeyPair()
    const a = await seal(kp.publicKey, "x", aad)
    const b = await seal(kp.publicKey, "x", aad)
    expect(a.enc).not.toBe(b.enc)
    expect(a.ct).not.toBe(b.ct)
  })

  test("wrong aad, wrong key and tampering fail", async () => {
    const kp = await generateKeyPair()
    const other = await generateKeyPair()
    const s = await seal(kp.publicKey, "tajné", aad)
    const longer = new Uint8Array([...aad, 0])
    await expect(open(kp.privateKey, s, longer)).rejects.toThrow(SealError)
    await expect(open(other.privateKey, s, aad)).rejects.toThrow(SealError)
    await expect(open(kp.privateKey, { ...s, ct: flipFirstBit(s.ct) }, aad)).rejects.toThrow(SealError)
    await expect(open(kp.privateKey, { ...s, enc: flipFirstBit(s.enc) }, aad)).rejects.toThrow(SealError)
  })

  test("private key: export and import keep the key, open takes either form", async () => {
    const kp = await generateKeyPair()
    const key = await importPrivateKey(kp.privateKey)
    expect(await exportPrivateKey(key)).toBe(kp.privateKey)
    expect(await exportPrivateKey(kp.privateKey)).toBe(kp.privateKey)
    // The stored form is a plain string, so IndexedDB keeps it exactly.
    expect(structuredClone(kp.privateKey)).toBe(kp.privateKey)
    const s = await seal(kp.publicKey, "ahoj", aad)
    expect(await open(key, s, aad)).toBe("ahoj")
  })

  test("envelopes: one per device, each opens with its own key", async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const list = await sealEnvelopes(
      [
        { deviceId: "d1", publicKey: a.publicKey },
        { deviceId: "d2", publicKey: b.publicKey },
      ],
      "oba",
      aad,
    )
    expect(list.map((e) => e.deviceId)).toEqual(["d1", "d2"])
    expect(await open(a.privateKey, list[0], aad)).toBe("oba")
    expect(await open(b.privateKey, list[1], aad)).toBe("oba")
    await expect(open(a.privateKey, list[1], aad)).rejects.toThrow(SealError)
  })

  test("bad keys and inputs are rejected before any crypto", async () => {
    const kp = await generateKeyPair()
    await expect(seal("not base64", "x", aad)).rejects.toThrow(SealError)
    await expect(seal("AAAA", "x", aad)).rejects.toThrow(/32 bytes/)
    await expect(seal(kp.publicKey.replace(/=$/, ""), "x", aad)).rejects.toThrow(SealError)
    await expect(seal(kp.publicKey, "x", "pingme v1|title|r|a|b" as never)).rejects.toThrow(/aadFor/)
    await expect(open(kp.privateKey, { enc: "AAAA", ct: "AAAA" }, aad)).rejects.toThrow(SealError)
  })
})

// Node and Chrome have WebCrypto X25519, so a green run alone would not catch a switch to it.
// Safari before 17 lacks X25519 there: only HMAC and HKDF (both old and everywhere) may use WebCrypto.
test("WebCrypto is used only for HMAC and HKDF, X25519 and ChaCha20 stay pure JS", async () => {
  const subtle = globalThis.crypto.subtle
  const used: string[] = []
  const methods = ["importKey", "exportKey", "generateKey", "deriveBits", "deriveKey", "sign", "verify", "encrypt", "decrypt"] as const
  for (const m of methods) {
    const orig = (subtle[m] as (...a: unknown[]) => unknown).bind(subtle)
    vi.spyOn(subtle, m).mockImplementation(((...a: unknown[]) => {
      const alg = m === "importKey" ? a[2] : m === "exportKey" ? (a[1] as CryptoKey).algorithm : a[0]
      used.push(typeof alg === "string" ? alg : (alg as { name: string }).name)
      return orig(...a)
    }) as never)
  }
  try {
    const kp = await generateKeyPair()
    const aad = aadFor({ kind: "title", ref: newRef(), from: "a", to: "b" })
    expect(await open(kp.privateKey, await seal(kp.publicKey, "x", aad), aad)).toBe("x")
  } finally {
    vi.restoreAllMocks()
  }
  expect(used.length).toBeGreaterThan(0)
  expect(used.filter((name) => name !== "HMAC" && name !== "HKDF")).toEqual([])
})

describe("pairing token", () => {
  test("opens only with its own info and AAD, never as a ping", async () => {
    const mac = await generateKeyPair()
    const info = new TextEncoder().encode(PAIR_INFO)
    const aad = pairTokenAad("AbCdEfGhIjKlMnOpQrStUv", "user1")
    expect(new TextDecoder().decode(aad)).toBe("pingme pair v1|AbCdEfGhIjKlMnOpQrStUv|user1")
    const token = "t".repeat(43)
    const sealed = await sealWithInfo(info, mac.publicKey, token, aad)
    expect(await openWithInfo(info, mac.privateKey, sealed, aad)).toBe(token)
    await expect(open(mac.privateKey, sealed, aad)).rejects.toThrow(SealError)
    await expect(openWithInfo(info, mac.privateKey, sealed, pairTokenAad("AbCdEfGhIjKlMnOpQrStUv", "user2"))).rejects.toThrow(SealError)
    expect(() => pairTokenAad("a|b", "user1")).toThrow(SealError)
    expect(() => pairTokenAad("abc", "")).toThrow(SealError)
  })
})

describe("aadFor and newRef", () => {
  test("aad is the exact contract string", () => {
    expect(new TextDecoder().decode(aadFor({ kind: "reply", ref: "r", from: "a", to: "b" }))).toBe("pingme v1|reply|r|a|b")
  })

  test("rejects separators, empty fields and unknown kinds", () => {
    expect(() => aadFor({ kind: "title", ref: "a|b", from: "a", to: "b" })).toThrow(SealError)
    expect(() => aadFor({ kind: "title", ref: "r", from: "", to: "b" })).toThrow(SealError)
    expect(() => aadFor({ kind: "title", ref: "r", from: "a", to: "b|c" })).toThrow(SealError)
    expect(() => aadFor({ kind: "other" as Kind, ref: "r", from: "a", to: "b" })).toThrow(SealError)
  })

  test("newRef is 16 random bytes, base64url, 22 chars", () => {
    const a = newRef()
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(newRef()).not.toBe(a)
  })
})

// PINGME_EMIT_VECTORS=out.json npx vitest run src/lib/seal.test.ts
// Writes TS-made vectors for keys.swift; paste them into "fromTs" by hand.
test.runIf(!!process.env.PINGME_EMIT_VECTORS)("emit TS-made vectors", async () => {
  const out: Vector[] = []
  for (const [kind, plaintext] of samples) {
    const v = { kind, ref: newRef(), from: "u_web_test", to: "u_mac_test" }
    out.push({ ...v, plaintext, ...(await seal(vectors.keys.swift.publicKey, plaintext, aadFor(v))) })
  }
  writeFileSync(process.env.PINGME_EMIT_VECTORS!, JSON.stringify(out, null, 2) + "\n")
})
