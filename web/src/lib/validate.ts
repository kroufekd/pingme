import { DAY_MS, MAX_DAYS, dateTime } from './time'

// Client-side checks for the three forms. They only catch what is certainly wrong
// (the server stays the judge), and they never change what gets sent.

export type EmailError = 'empty' | 'space' | 'no-at' | 'no-domain' | 'bad'
export type EmailCheck = { ok: true; value: string } | { ok: false; error: EmailError }

export const EMAIL_NOTES: Record<EmailError, string> = {
  empty: 'Enter your email.',
  space: 'No spaces in an email.',
  'no-at': 'Missing the @.',
  'no-domain': 'Missing the domain.',
  bad: 'Check the email.',
}

/** Structure only: something@domain.tld without spaces. Plus signs, long TLDs and accents pass. */
export function checkEmail(raw: string): EmailCheck {
  const value = raw.trim()
  if (!value) return { ok: false, error: 'empty' }
  if (/\s/.test(value)) return { ok: false, error: 'space' }
  const at = value.indexOf('@')
  if (at === -1) return { ok: false, error: 'no-at' }
  if (at === 0 || value.indexOf('@', at + 1) !== -1) return { ok: false, error: 'bad' }
  const domain = value.slice(at + 1)
  const dot = domain.lastIndexOf('.')
  if (!domain || dot === -1 || dot === domain.length - 1) return { ok: false, error: 'no-domain' }
  if (dot === 0 || domain.includes('..') || domain.length - dot - 1 < 2) return { ok: false, error: 'bad' }
  return { ok: true, value }
}

/** Mailboxes people here really use. A domain one slip away from one of these is offered as a fix. */
const COMMON = ['gmail.com', 'seznam.cz', 'centrum.cz', 'outlook.com', 'outlook.cz', 'hotmail.com', 'icloud.com', 'yahoo.com', 'protonmail.com', 'volny.cz']
/** Slips that are not "one letter off", and short names where a distance rule would be a guess. */
const KNOWN_SLIPS: Record<string, string> = {
  'gmail.cz': 'gmail.com',
  'gmail.sk': 'gmail.com',
  'googlemail.cz': 'gmail.com',
  'gmai.com': 'gmail.com',
  'seznam.com': 'seznam.cz',
  'seznam.sk': 'seznam.cz',
  'sezam.cz': 'seznam.cz',
  'centrum.com': 'centrum.cz',
  'emial.cz': 'email.cz',
  'emai.cz': 'email.cz',
  'post.cy': 'post.cz',
  'pots.cz': 'post.cz',
  'icloud.cz': 'icloud.com',
  'hotmail.cz': 'hotmail.com',
  'yahoo.cz': 'yahoo.com',
}
/** Real domains that only look like a slip of a common one. Never "fixed". */
const REAL = new Set([...COMMON, 'email.cz', 'post.cz', 'atlas.cz', 'proton.me', 'mail.com', 'email.com', 'ymail.com', 'gmx.com', 'me.com', 'mac.com', 'live.com', 'msn.com', 'outlook.sk', 'centrum.sk', 'post.sk', 'azet.sk', 'zoznam.sk'])

/** True when `a` becomes `b` by one insert, delete, replace, or swap of two neighbours. */
export function oneSlipApart(a: string, b: string) {
  if (a === b) return false
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (long.length - short.length > 1) return false
  let i = 0
  while (i < short.length && short[i] === long[i]) i += 1
  if (short.length === long.length) {
    if (short.slice(i + 1) === long.slice(i + 1)) return true
    return short[i] === long[i + 1] && short[i + 1] === long[i] && short.slice(i + 2) === long.slice(i + 2)
  }
  return short.slice(i) === long.slice(i + 1)
}

/** The same address with a likely domain typo fixed, or null. The part before @ is kept as typed. */
export function suggestEmail(raw: string): string | null {
  const res = checkEmail(raw)
  if (!res.ok) return null
  const at = res.value.indexOf('@')
  const domain = res.value.slice(at + 1).toLowerCase()
  if (REAL.has(domain)) return null
  const fixed = KNOWN_SLIPS[domain] ?? COMMON.find((d) => oneSlipApart(domain, d))
  return fixed ? res.value.slice(0, at + 1) + fixed : null
}

export const CODE_LENGTH = 6
export const CODE_SHORT = `The code has ${CODE_LENGTH} digits.`

/** Digits only, cut to the code length. A pasted "419 275" or "419-275" becomes the whole code. */
export function cleanCode(raw: string) {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH)
}

export type LaterError = 'no-time' | 'past-time' | 'bad-time'
export type LaterCheck = { ok: true; at: number } | { ok: false; error: LaterError }

/** "Later" must be a real time, not in the past (a minute of grace) and at most MAX_DAYS ahead. */
export function checkLater(day: string, time: string, now: number): LaterCheck {
  const at = dateTime(day, time)
  if (at === null) return { ok: false, error: 'no-time' }
  if (at < now - 60_000) return { ok: false, error: 'past-time' }
  if (at > now + MAX_DAYS * DAY_MS) return { ok: false, error: 'bad-time' }
  return { ok: true, at }
}

/** The count of characters left shows up only this close to the limit. */
export const COUNT_FROM = 30
export function charsLeft(length: number, max: number): number | null {
  const left = max - length
  return left <= COUNT_FROM ? Math.max(left, 0) : null
}
