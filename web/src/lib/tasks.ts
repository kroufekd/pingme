import { dueLabel, snoozeLabel } from './time'
import type { Repeat } from './time'

// Shapes from the API contract (contract.md, section 2).
export type Urgency = 'green' | 'orange' | 'red'
/** Who it is for: Dominik, or his agent (a small model on his Mac reads it first). */
export type Recipient = 'dominik' | 'agent'
export type Status = 'queued' | 'waiting' | 'popped' | 'seen' | 'replied' | 'done' | 'snoozed'

export type Row = {
  taskRef: string
  title: string | null
  urgency: Urgency
  to?: Recipient
  dueAt: number | null
  repeat?: Repeat
  status: Status
  statusAt: number
  snoozedUntil?: number
  typingUntil?: number
  reply?: string
  replyAt?: number
  replyPending: boolean
  createdAt: number
}

export type Mine =
  | { status: 'signedOut' }
  | { status: 'notMember' }
  | { status: 'member'; name: string; macLastSeen: number | null; snapshotAt: number | null; rows: Row[] }

export type Me =
  | { status: 'signedOut' }
  | { status: 'notMember'; email: string }
  | { status: 'member'; name: string; senderId: string }

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

export function kindOf(row: Pick<Row, 'status' | 'typingUntil'>, now: number): Kind {
  if (row.status !== 'done' && row.typingUntil !== undefined && row.typingUntil > now) return 'typing'
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
