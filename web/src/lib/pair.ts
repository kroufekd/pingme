// /pair#<pairId>.<secret>: the Mac opens this page. The fragment never reaches the server;
// only the SHA-256 of the secret string does, so the page cannot be replayed from logs.

const PAIR_ID = /^[A-Za-z0-9_-]{22}$/
const SECRET = /^[A-Za-z0-9_-]{43}$/

export function parsePairHash(hash: string): { pairId: string; secret: string } | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const dot = raw.indexOf('.')
  if (dot < 0) return null
  const pairId = raw.slice(0, dot)
  const secret = raw.slice(dot + 1)
  return PAIR_ID.test(pairId) && SECRET.test(secret) ? { pairId, secret } : null
}

/** Lowercase hex SHA-256 of the UTF-8 of the secret as written in the URL (not its decoded bytes). */
export async function secretHash(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
