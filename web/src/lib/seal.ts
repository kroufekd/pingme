// End-to-end encryption for pingme v1. The server only relays what this file produces.
//
// HPKE (RFC 9180) base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, info "pingme v1".
// The Mac twin is mac/Sources/Seal.swift; shared/hpke-vectors.json proves both sides agree.
//
// X25519 and ChaCha20-Poly1305 are pure JS (noble), so this runs where WebCrypto lacks them
// (older Safari, jsdom). HKDF still uses WebCrypto HMAC/HKDF, which every secure (https) context has.
//
// Keys are raw 32-byte X25519 values as standard base64 strings. Store the private key string in
// IndexedDB as-is: the library's key object is a plain JS class and does not survive structured clone.

import { CipherSuite, HkdfSha256 } from "@hpke/core"
// Not the DhkemX25519HkdfSha256 from @hpke/core: that one needs WebCrypto X25519 (Safari 17+ only).
import { DhkemX25519HkdfSha256, X25519 } from "@hpke/dhkem-x25519"
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305"

export const INFO = "pingme v1"

export type Kind = "title" | "reply"
/** Output of seal(), base64. */
export type Sealed = { enc: string; ct: string }
/** One sealed copy per target device. */
export type Envelope = { deviceId: string; enc: string; ct: string }
/** Raw 32-byte private key as base64 (what generateKeyPair returns), or an imported key. */
export type PrivateKey = string | CryptoKey

export class SealError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SealError"
  }
}

const KEY_BYTES = 32
const enc8 = new TextEncoder()

// Lazy, so importing this module during SSR never touches WebCrypto.
let cached: { suite: CipherSuite; x25519: X25519 } | null = null
function lib() {
  cached ??= {
    suite: new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() }),
    x25519: new X25519(new HkdfSha256()),
  }
  return cached
}

/** New device key pair. Both halves are raw 32 bytes, standard base64. */
export async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const { suite } = lib()
  const kp = await suite.kem.generateKeyPair()
  return {
    publicKey: toB64(new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey))),
    privateKey: toB64(new Uint8Array(await suite.kem.serializePrivateKey(kp.privateKey))),
  }
}

/** Raw base64 private key to the library key object, e.g. to cache it in memory. */
export async function importPrivateKey(privateKeyB64: string): Promise<CryptoKey> {
  return lib().suite.kem.deserializePrivateKey(decodeKey(privateKeyB64, "privateKey"))
}

/** Library key object (or a base64 string, returned normalized) to raw 32 bytes base64. */
export async function exportPrivateKey(key: PrivateKey): Promise<string> {
  if (typeof key === "string") return toB64(decodeKey(key, "privateKey"))
  return toB64(new Uint8Array(await lib().suite.kem.serializePrivateKey(key)))
}

/** Public key that belongs to a private key, both raw base64. */
export async function publicKeyFor(privateKey: PrivateKey): Promise<string> {
  const { x25519 } = lib()
  const sk = typeof privateKey === "string" ? await importPrivateKey(privateKey) : privateKey
  return toB64(new Uint8Array(await x25519.serializePublicKey(await x25519.derivePublicKey(sk))))
}

/** Encrypts plaintext (UTF-8) for one recipient public key. Every call uses a fresh ephemeral key. */
export async function seal(publicKeyB64: string, plaintext: string, aad: Uint8Array): Promise<Sealed> {
  return sealWithInfo(enc8.encode(INFO), publicKeyB64, plaintext, aad)
}

/** seal() with another info string. Only for the pairing token (PAIR_INFO); app code calls seal(). */
export async function sealWithInfo(info: Uint8Array, publicKeyB64: string, plaintext: string, aad: Uint8Array): Promise<Sealed> {
  if (typeof plaintext !== "string") throw new SealError("plaintext must be a string")
  checkAad(aad)
  const { suite } = lib()
  const recipientPublicKey = await suite.kem.deserializePublicKey(decodeKey(publicKeyB64, "publicKey"))
  const out = await suite.seal({ recipientPublicKey, info }, enc8.encode(plaintext), aad)
  return { enc: toB64(new Uint8Array(out.enc)), ct: toB64(new Uint8Array(out.ct)) }
}

/** Decrypts. Throws on a wrong key, wrong AAD or any tampering; never returns partial text. */
export async function open(privateKey: PrivateKey, sealed: Sealed, aad: Uint8Array): Promise<string> {
  return openWithInfo(enc8.encode(INFO), privateKey, sealed, aad)
}

/** Only for the RFC 9180 known-answer test, which uses its own info. App code calls open(). */
export async function openWithInfo(
  info: Uint8Array,
  privateKey: PrivateKey,
  sealed: Sealed,
  aad: Uint8Array,
): Promise<string> {
  checkAad(aad)
  const enc = decodeKey(sealed?.enc, "enc")
  const ct = fromB64(sealed?.ct, "ct")
  const recipientKey = typeof privateKey === "string" ? await importPrivateKey(privateKey) : privateKey
  let pt: ArrayBuffer
  try {
    pt = await lib().suite.open({ recipientKey, enc, info }, ct, aad)
  } catch {
    throw new SealError("cannot open")
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(pt)
  } catch {
    throw new SealError("plaintext is not UTF-8")
  }
}

/** Seals the same plaintext once per device, in the shape the server stores. */
export async function sealEnvelopes(
  devices: { deviceId: string; publicKey: string }[],
  plaintext: string,
  aad: Uint8Array,
): Promise<Envelope[]> {
  return Promise.all(devices.map(async (d) => ({ deviceId: d.deviceId, ...(await seal(d.publicKey, plaintext, aad)) })))
}

/**
 * "pingme v1|kind|ref|from|to" as UTF-8. Binds the ciphertext to its message and both users,
 * so the server cannot move a sealed text to another task or person.
 */
export function aadFor(p: { kind: Kind; ref: string; from: string; to: string }): Uint8Array {
  if (p.kind !== "title" && p.kind !== "reply") throw new SealError("kind must be title or reply")
  for (const [name, v] of [["ref", p.ref], ["from", p.from], ["to", p.to]] as const) {
    // "|" is the separator, so a field containing it could forge another field's boundary.
    if (typeof v !== "string" || v.length === 0 || v.includes("|")) throw new SealError(`bad ${name}`)
  }
  return enc8.encode(`${INFO}|${p.kind}|${p.ref}|${p.from}|${p.to}`)
}

/**
 * The device token a paired Mac gets is sealed to the public key it registered, so only the
 * holder of that private key can use it. Own info string: it can never open as a ping or reply.
 */
export const PAIR_INFO = "pingme pair v1"

/** "pingme pair v1|pairId|userId" as UTF-8: the token is bound to its pairing and account. */
export function pairTokenAad(pairId: string, userId: string): Uint8Array {
  for (const [name, v] of [["pairId", pairId], ["userId", userId]] as const) {
    if (typeof v !== "string" || v.length === 0 || v.includes("|")) throw new SealError(`bad ${name}`)
  }
  return enc8.encode(`${PAIR_INFO}|${pairId}|${userId}`)
}

/** Fresh task reference: 16 random bytes, base64url without padding (22 chars). */
export function newRef(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

// Browser-safe base64 (no Buffer, no Uint8Array.toBase64), padded so Swift's Data(base64Encoded:) accepts it.
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function toB64(bytes: Uint8Array): string {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(s: unknown, what = "value"): Uint8Array {
  if (typeof s !== "string" || !B64.test(s)) throw new SealError(`${what} is not base64`)
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// isView, not instanceof: under jsdom TextEncoder returns a Uint8Array from another realm.
function checkAad(aad: unknown) {
  if (!ArrayBuffer.isView(aad)) throw new SealError("aad must come from aadFor()")
}

function decodeKey(s: unknown, what: string): Uint8Array {
  const bytes = fromB64(s, what)
  if (bytes.length !== KEY_BYTES) throw new SealError(`${what} must be ${KEY_BYTES} bytes`)
  return bytes
}
