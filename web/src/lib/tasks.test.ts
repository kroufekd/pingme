import { describe, expect, it } from 'vitest'
import { kindOf, spokenFor, wordFor } from './tasks'
import { dueLabel, snoozeLabel } from './time'

// Monday 16 Nov 2026, 14:02 local time.
const NOW = new Date(2026, 10, 16, 14, 2).getTime()
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime()
const row = { dueAt: null, snoozedUntil: undefined }

describe('status words', () => {
  it('maps every server status to its word', () => {
    expect(wordFor('queued', row, NOW)).toBe('letí')
    expect(wordFor('popped', row, NOW)).toBe('vyskočilo')
    expect(wordFor('seen', row, NOW)).toBe('viděl')
    expect(wordFor('typing', row, NOW)).toBe('píše')
    expect(wordFor('replied', row, NOW)).toBe('odpověď')
    expect(wordFor('done', row, NOW)).toBe('hotovo')
  })

  it('shows when a waiting task pops up', () => {
    expect(wordFor('waiting', { ...row, dueAt: at(17, 18, 0) }, NOW)).toBe('zítra 18:00')
    expect(wordFor('waiting', { ...row, dueAt: at(18, 18, 0) }, NOW)).toBe('st 18:00')
    expect(wordFor('waiting', row, NOW)).toBe('čeká')
    expect(spokenFor('waiting', { ...row, dueAt: at(19, 18, 0) }, NOW)).toBe('čeká, čt 18:00')
  })

  it('shows a snooze as minutes left or as a time', () => {
    expect(wordFor('snoozed', { ...row, snoozedUntil: NOW + 10 * 60_000 }, NOW)).toBe('za 10 min')
    expect(wordFor('snoozed', { ...row, snoozedUntil: at(16, 16, 12) }, NOW)).toBe('do 16:12')
    expect(spokenFor('snoozed', { ...row, snoozedUntil: NOW + 5 * 60_000 }, NOW)).toBe('odloženo, za 5 min')
  })

  it('"píše" wins while typingUntil is ahead, but never over done', () => {
    expect(kindOf({ status: 'seen', typingUntil: NOW + 3000 }, NOW)).toBe('typing')
    expect(kindOf({ status: 'seen', typingUntil: NOW - 1 }, NOW)).toBe('seen')
    expect(kindOf({ status: 'done', typingUntil: NOW + 3000 }, NOW)).toBe('done')
  })
})

describe('time labels', () => {
  it('formats due times', () => {
    expect(dueLabel(at(16, 18, 0), NOW)).toBe('18:00')
    expect(dueLabel(at(17, 9, 30), NOW)).toBe('zítra 9:30')
    expect(dueLabel(at(30, 9, 30), NOW)).toBe('30. 11.')
  })

  it('formats snoozes', () => {
    expect(snoozeLabel(undefined, NOW)).toBe('odloženo')
    expect(snoozeLabel(NOW + 30_000, NOW)).toBe('za 1 min')
  })
})
