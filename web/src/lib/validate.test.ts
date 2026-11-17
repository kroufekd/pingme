import { describe, expect, it } from 'vitest'
import { DAY_MS, MAX_DAYS } from './time'
import { CODE_LENGTH, charsLeft, checkEmail, checkLater, cleanCode, oneSlipApart, suggestEmail } from './validate'

describe('checkEmail', () => {
  it('passes real addresses and returns them trimmed, otherwise untouched', () => {
    expect(checkEmail('  Franta.Novak+pingme@Example.com ')).toEqual({ ok: true, value: 'Franta.Novak+pingme@Example.com' })
    for (const ok of ['a@b.cz', 'jana@firma.technology', 'petr@mail.firma.co.uk', 'žofie@škola.cz']) expect(checkEmail(ok).ok).toBe(true)
  })

  it('names what is wrong', () => {
    const error = (raw: string) => {
      const res = checkEmail(raw)
      return res.ok ? null : res.error
    }
    expect(error('')).toBe('empty')
    expect(error('   ')).toBe('empty')
    expect(error('franta novak@seznam.cz')).toBe('space')
    expect(error('franta@sez nam.cz')).toBe('space')
    expect(error('franta.seznam.cz')).toBe('no-at')
    expect(error('franta@')).toBe('no-domain')
    expect(error('franta@seznam')).toBe('no-domain')
    expect(error('franta@seznam.')).toBe('no-domain')
    expect(error('@seznam.cz')).toBe('bad')
    expect(error('franta@@seznam.cz')).toBe('bad')
    expect(error('franta@.cz')).toBe('bad')
    expect(error('franta@seznam..cz')).toBe('bad')
    expect(error('franta@seznam.c')).toBe('bad')
  })
})

describe('suggestEmail', () => {
  it('fixes a slip in a common domain and keeps the name as typed', () => {
    const fixes: Record<string, string> = {
      'franta@gmial.com': 'franta@gmail.com',
      'franta@gmail.cz': 'franta@gmail.com',
      'franta@gmail.con': 'franta@gmail.com',
      'franta@gmail.co': 'franta@gmail.com',
      'franta@gmai.com': 'franta@gmail.com',
      'franta@gmaill.com': 'franta@gmail.com',
      'franta@seznam.com': 'franta@seznam.cz',
      'franta@senzam.cz': 'franta@seznam.cz',
      'franta@seznm.cz': 'franta@seznam.cz',
      'franta@sezna.cz': 'franta@seznam.cz',
      'franta@emial.cz': 'franta@email.cz',
      'franta@centrum.com': 'franta@centrum.cz',
      'franta@outlok.com': 'franta@outlook.com',
      'franta@hotmial.com': 'franta@hotmail.com',
      'franta@iclod.com': 'franta@icloud.com',
      'franta@yaho.com': 'franta@yahoo.com',
    }
    for (const [typed, fixed] of Object.entries(fixes)) expect(suggestEmail(typed), typed).toBe(fixed)
    expect(suggestEmail(' Franta.N+x@GMIAL.com ')).toBe('Franta.N+x@gmail.com')
  })

  it('leaves real and unknown domains alone', () => {
    for (const fine of [
      'a@gmail.com',
      'a@seznam.cz',
      'a@email.cz',
      'a@post.cz',
      'a@mail.com',
      'a@ymail.com',
      'a@email.com',
      'a@post.sk',
      'a@centrum.sk',
      'a@outlook.cz',
      'a@proton.me',
      'a@example.com',
      'a@firma.cz',
      'a@macaly.com',
    ])
      expect(suggestEmail(fine), fine).toBeNull()
  })

  it('offers nothing for an address that is not valid yet', () => {
    expect(suggestEmail('franta@gmial')).toBeNull()
    expect(suggestEmail('')).toBeNull()
  })

  it('counts one slip: a missing, extra, wrong or swapped letter', () => {
    expect(oneSlipApart('gmial.com', 'gmail.com')).toBe(true)
    expect(oneSlipApart('gmal.com', 'gmail.com')).toBe(true)
    expect(oneSlipApart('gmaail.com', 'gmail.com')).toBe(true)
    expect(oneSlipApart('gnail.com', 'gmail.com')).toBe(true)
    expect(oneSlipApart('gmail.com', 'gmail.com')).toBe(false)
    expect(oneSlipApart('gmlia.com', 'gmail.com')).toBe(false)
    expect(oneSlipApart('email.com', 'gmail.cz')).toBe(false)
  })
})

describe('cleanCode', () => {
  it('keeps digits only, up to the code length', () => {
    expect(CODE_LENGTH).toBe(6)
    expect(cleanCode('419275')).toBe('419275')
    expect(cleanCode(' 419 275 ')).toBe('419275')
    expect(cleanCode('419-275')).toBe('419275')
    expect(cleanCode('Kód: 419275.')).toBe('419275')
    expect(cleanCode('4192759')).toBe('419275')
    expect(cleanCode('abc')).toBe('')
  })
})

describe('checkLater', () => {
  // Monday 16 Nov 2026, 14:02 local time.
  const NOW = new Date(2026, 10, 16, 14, 2).getTime()

  it('takes a time ahead and returns it', () => {
    expect(checkLater('2026-11-16', '15:00', NOW)).toEqual({ ok: true, at: new Date(2026, 10, 16, 15, 0).getTime() })
  })

  it('allows a minute of grace, not more', () => {
    expect(checkLater('2026-11-16', '14:02', NOW + 59_000).ok).toBe(true)
    expect(checkLater('2026-11-16', '14:00', NOW)).toEqual({ ok: false, error: 'past-time' })
    expect(checkLater('2026-11-15', '18:00', NOW)).toEqual({ ok: false, error: 'past-time' })
  })

  it('stops at MAX_DAYS ahead', () => {
    const edge = new Date(NOW + MAX_DAYS * DAY_MS)
    const day = `${edge.getFullYear()}-${String(edge.getMonth() + 1).padStart(2, '0')}-${String(edge.getDate()).padStart(2, '0')}`
    expect(checkLater(day, '14:02', NOW).ok).toBe(true)
    expect(checkLater(day, '14:03', NOW)).toEqual({ ok: false, error: 'bad-time' })
    expect(checkLater('2027-06-01', '09:00', NOW)).toEqual({ ok: false, error: 'bad-time' })
  })

  it('asks for a day and a time when one is missing', () => {
    expect(checkLater('', '15:00', NOW)).toEqual({ ok: false, error: 'no-time' })
    expect(checkLater('2026-11-16', '', NOW)).toEqual({ ok: false, error: 'no-time' })
  })
})

describe('charsLeft', () => {
  it('stays silent until the last 30 characters', () => {
    expect(charsLeft(0, 200)).toBeNull()
    expect(charsLeft(169, 200)).toBeNull()
    expect(charsLeft(170, 200)).toBe(30)
    expect(charsLeft(199, 200)).toBe(1)
    expect(charsLeft(200, 200)).toBe(0)
    expect(charsLeft(205, 200)).toBe(0)
  })
})
