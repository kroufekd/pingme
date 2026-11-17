// An invite link is /?i=<token>. The token stays in this browser until the claim succeeds,
// so a reload or a trip to the mail app in the middle of sign-in does not lose it.
const KEY = 'pingme.invite'
const PARAM = 'i'

export function loadInvite(): string | null {
  let fromUrl: string | null = null
  try {
    fromUrl = new URL(window.location.href).searchParams.get(PARAM)
  } catch {
    fromUrl = null
  }
  try {
    if (fromUrl) {
      localStorage.setItem(KEY, fromUrl)
      return fromUrl
    }
    return localStorage.getItem(KEY)
  } catch {
    return fromUrl
  }
}

export function clearInvite() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // Nothing stored.
  }
  try {
    const url = new URL(window.location.href)
    if (url.searchParams.has(PARAM)) {
      url.searchParams.delete(PARAM)
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  } catch {
    // The address keeps the param, the token is gone anyway.
  }
}


// The email typed in the first step, so the code step survives a reload while the code is valid.
const OTP_KEY = 'pingme.otp'
const OTP_MS = 15 * 60_000

export function loadOtpEmail(): string | null {
  try {
    const raw = sessionStorage.getItem(OTP_KEY)
    if (!raw) return null
    const { email, at } = JSON.parse(raw) as { email?: string; at?: number }
    if (typeof email !== 'string' || typeof at !== 'number' || Date.now() - at > OTP_MS) return null
    return email
  } catch {
    return null
  }
}

export function saveOtpEmail(email: string | null) {
  try {
    if (email) sessionStorage.setItem(OTP_KEY, JSON.stringify({ email, at: Date.now() }))
    else sessionStorage.removeItem(OTP_KEY)
  } catch {
    // Kept in memory only.
  }
}
