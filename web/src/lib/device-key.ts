import { generateKeyPair } from './seal'
import { vaultDelete, vaultGet, vaultSet } from './vault'

/** This browser's device key. Raw X25519 halves as base64, exactly what seal.ts takes. */
export type DeviceKey = { publicKey: string; privateKey: string }

const KEY = 'deviceKey'
const B64_32 = /^[A-Za-z0-9+/]{43}=$/

function valid(k: unknown): k is DeviceKey {
  const o = k as Partial<DeviceKey> | null
  return !!o && typeof o.publicKey === 'string' && typeof o.privateKey === 'string' && B64_32.test(o.publicKey) && B64_32.test(o.privateKey)
}

// One in flight per page, so two mounts (or StrictMode) never make two keys.
let loading: Promise<DeviceKey> | null = null

/** The stored key, or a new one saved for next time. Never rejects for storage reasons. */
export function loadDeviceKey(): Promise<DeviceKey> {
  loading ??= (async () => {
    let stored: unknown
    try {
      stored = await vaultGet(KEY)
    } catch {
      stored = undefined
    }
    if (valid(stored)) return { publicKey: stored.publicKey, privateKey: stored.privateKey }
    const fresh = await generateKeyPair()
    try {
      await vaultSet(KEY, fresh)
    } catch {
      // Kept for this page only.
    }
    return fresh
  })().catch((e) => {
    loading = null
    throw e
  })
  return loading
}

/** Tests only. */
export function resetDeviceKey() {
  loading = null
}

/** Signing out: this browser's key is gone, the next account gets a new one. */
export async function forgetDeviceKey() {
  loading = null
  await vaultDelete(KEY).catch(() => {})
}

/** A short device name for the device list: "Safari · iPhone". */
export function browserName(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Web'
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : ''
  return os ? `${browser} · ${os}` : browser
}
