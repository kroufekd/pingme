import { describe, expect, it } from 'vitest'
import { autoNote, kindOf, spokenFor, wordFor } from './tasks'
import { dueLabel, snoozeLabel } from './time'

// Monday 16 Nov 2026, 14:02 local time.
const NOW = new Date(2026, 10, 16, 14, 2).getTime()
const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime()
const row = { dueAt: null, snoozedUntil: undefined }

describe('status words', () => {
  it('maps every server status to its word', () => {
    expect(wordFor('queued', row, NOW)).toBe('sending')
    expect(wordFor('popped', row, NOW)).toBe('popped up')
    expect(wordFor('seen', row, NOW)).toBe('seen')
    expect(wordFor('typing', row, NOW)).toBe('typing')
    expect(wordFor('replied', row, NOW)).toBe('reply')
    expect(wordFor('done', row, NOW)).toBe('done')
  })

  it('shows when a waiting task pops up', () => {
    expect(wordFor('waiting', { ...row, dueAt: at(17, 18, 0) }, NOW)).toBe('tomorrow 18:00')
    expect(wordFor('waiting', { ...row, dueAt: at(18, 18, 0) }, NOW)).toBe('Wed 18:00')
    expect(wordFor('waiting', row, NOW)).toBe('waiting')
    expect(spokenFor('waiting', { ...row, dueAt: at(19, 18, 0) }, NOW)).toBe('waiting, Thu 18:00')
  })

  it('shows a snooze as minutes left or as a time', () => {
    expect(wordFor('snoozed', { ...row, snoozedUntil: NOW + 10 * 60_000 }, NOW)).toBe('in 10 min')
    expect(wordFor('snoozed', { ...row, snoozedUntil: at(16, 16, 12) }, NOW)).toBe('until 16:12')
    expect(spokenFor('snoozed', { ...row, snoozedUntil: NOW + 5 * 60_000 }, NOW)).toBe('snoozed, in 5 min')
  })

  it('"typing" wins while typingUntil is ahead, but never over done', () => {
    expect(kindOf({ status: 'seen', typingUntil: NOW + 3000 }, NOW)).toBe('typing')
    expect(kindOf({ status: 'seen', typingUntil: NOW - 1 }, NOW)).toBe('seen')
    expect(kindOf({ status: 'done', typingUntil: NOW + 3000 }, NOW)).toBe('done')
  })
})

describe('time labels', () => {
  it('formats due times', () => {
    expect(dueLabel(at(16, 18, 0), NOW)).toBe('18:00')
    expect(dueLabel(at(17, 9, 30), NOW)).toBe('tomorrow 9:30')
    expect(dueLabel(at(30, 9, 30), NOW)).toBe('30/11')
  })

  it('formats snoozes', () => {
    expect(snoozeLabel(undefined, NOW)).toBe('snoozed')
    expect(snoozeLabel(NOW + 30_000, NOW)).toBe('in 1 min')
  })
})

describe('automatic note from their Mac', () => {
  it('is the note, without its marker, only on a ping for an agent', () => {
    expect(autoNote(true, '[auto] Got it, passed on to Jakub.')).toBe('Got it, passed on to Jakub.')
    expect(autoNote(false, '[auto] Got it')).toBeUndefined()
    expect(autoNote(true, 'Jo, na mate.macaly.com')).toBeUndefined()
    expect(autoNote(true, undefined)).toBeUndefined()
    expect(autoNote(true, '[auto]  ')).toBeUndefined()
  })
})
