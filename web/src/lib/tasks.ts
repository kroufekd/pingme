import { dueLabel, snoozeLabel } from './time'
import type { Repeat } from './time'

// What the sent list shows. Network rows are mapped into this in use-network.ts.
export type Urgency = 'green' | 'orange' | 'red'
/** Who it is for: the person, or their agent (a small model on their Mac reads it first). */
export type Recipient = 'person' | 'agent'
export type Status = 'queued' | 'waiting' | 'popped' | 'seen' | 'replied' | 'done' | 'snoozed'

export type Row = {
  taskRef: string
  /** Null while it is being decrypted. */
  title: string | null
  /** Sealed for another device (or this browser lost its key): it cannot be read here. */
  titleMissing?: boolean
  urgency: Urgency
  to?: Recipient
  /** Who it went to, shown once there is more than one contact. */
  toName?: string
  /** The recipient's Mac is not running: a queued ping shows "čeká". */
  offline?: boolean
  dueAt: number | null
  repeat?: Repeat
  status: Status
  statusAt: number
  snoozedUntil?: number
  typingUntil?: number
  reply?: string
  /** A reply exists but was sealed for another device. */
  replyMissing?: boolean
  replyAt?: number
  /** A reply this device has not marked as shown yet. */
  replyPending: boolean
  createdAt: number
}

export type Me =
  | { status: 'signedOut' }
  | { status: 'notMember'; email: string }
  | { status: 'member'; name: string; userId: string; senderId?: string; onboarded?: boolean; inviterName?: string }

export const URGENCIES: { value: Urgency; word: string; cls: string }[] = [
  { value: 'green', word: 'Počká', cls: 'u-g' },
  { value: 'orange', word: 'Brzy', cls: 'u-o' },
  { value: 'red', word: 'Hned', cls: 'u-r' },
]

export function urgencyOf(u: Urgency) {
  return URGENCIES.find((x) => x.value === u) ?? URGENCIES[0]
}

export const REPEAT_OPTIONS: { value: Repeat | ''; label: string }[] = [
  { value: '', label: 'Jednou' },
  { value: 'daily', label: 'Každý den' },
  { value: 'weekdays', label: 'Pracovní dny' },
  { value: 'weekly', label: 'Každý týden' },
  { value: 'biweekly', label: 'Po 14 dnech' },
  { value: 'monthly', label: 'Každý měsíc' },
]

/** What the status cell shows. "typing" is not a server status, it wins while typingUntil is ahead. */
export type Kind = 'queued' | 'waiting' | 'popped' | 'seen' | 'typing' | 'replied' | 'done' | 'snoozed'
export const KINDS: Kind[] = ['queued', 'waiting', 'popped', 'seen', 'typing', 'replied', 'done', 'snoozed']

export const ICONS: Record<Exclude<Kind, 'typing'>, string> = {
  queued: 'send',
  waiting: 'clock',
  popped: 'bell',
  seen: 'eye',
  replied: 'reply',
  done: 'check',
  snoozed: 'snooze',
}

export function kindOf(row: Pick<Row, 'status' | 'typingUntil' | 'offline'>, now: number): Kind {
  if (row.status !== 'done' && row.typingUntil !== undefined && row.typingUntil > now) return 'typing'
  // The server says queued until a Mac picks it up; with the Mac off it simply waits.
  if (row.status === 'queued' && row.offline) return 'waiting'
  return row.status
}

/** The short word under the icon. Planned and snoozed tasks show their time instead. */
export function wordFor(kind: Kind, row: Pick<Row, 'dueAt' | 'snoozedUntil'>, now: number) {
  switch (kind) {
    case 'queued':
      return 'letí'
    case 'waiting':
      return row.dueAt === null ? 'čeká' : dueLabel(row.dueAt, now)
    case 'popped':
      return 'vyskočilo'
    case 'seen':
      return 'viděl'
    case 'typing':
      return 'píše'
    case 'replied':
      return 'odpověď'
    case 'done':
      return 'hotovo'
    case 'snoozed':
      return snoozeLabel(row.snoozedUntil, now)
  }
}

/** Full text for screen readers, where the visible word alone is a bare time. */
export function spokenFor(kind: Kind, row: Pick<Row, 'dueAt' | 'snoozedUntil'>, now: number) {
  const word = wordFor(kind, row, now)
  if (kind === 'waiting' && row.dueAt !== null) return `čeká, ${word}`
  if (kind === 'snoozed') return `odloženo, ${word}`
  return word
}
