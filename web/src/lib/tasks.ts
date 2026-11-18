import { dueLabel, snoozeLabel } from './time'

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
  /** The recipient's Mac is not running: a queued ping shows "waiting". */
  offline?: boolean
  /** No Mac of theirs came on in time: it will not arrive. */
  undelivered?: boolean
  dueAt: number | null
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
  { value: 'green', word: 'Can wait', cls: 'u-g' },
  { value: 'orange', word: 'Soon', cls: 'u-o' },
  { value: 'red', word: 'Now', cls: 'u-r' },
]

export function urgencyOf(u: Urgency) {
  return URGENCIES.find((x) => x.value === u) ?? URGENCIES[0]
}

/** What the status cell shows. "typing" is not a server status, it wins while typingUntil is ahead. */
export type Kind = 'queued' | 'waiting' | 'lost' | 'popped' | 'seen' | 'typing' | 'replied' | 'done' | 'snoozed'
export const KINDS: Kind[] = ['queued', 'waiting', 'lost', 'popped', 'seen', 'typing', 'replied', 'done', 'snoozed']

export const ICONS: Record<Exclude<Kind, 'typing'>, string> = {
  queued: 'send',
  waiting: 'clock',
  lost: 'alert',
  popped: 'bell',
  seen: 'eye',
  replied: 'reply',
  done: 'check',
  snoozed: 'snooze',
}

export function kindOf(row: Pick<Row, 'status' | 'typingUntil' | 'offline' | 'undelivered'>, now: number): Kind {
  if (row.status !== 'done' && row.typingUntil !== undefined && row.typingUntil > now) return 'typing'
  // Their Mac stayed off for a week after it was due: it will not arrive, say so instead of vanishing.
  if (row.status === 'queued' && row.undelivered) return 'lost'
  // The server says queued until a Mac picks it up; with the Mac off it simply waits.
  if (row.status === 'queued' && row.offline) return 'waiting'
  return row.status
}

/** The short word under the icon. Planned and snoozed tasks show their time instead. */
export function wordFor(kind: Kind, row: Pick<Row, 'dueAt' | 'snoozedUntil'>, now: number) {
  switch (kind) {
    case 'queued':
      return 'sending'
    case 'waiting':
      return row.dueAt === null ? 'waiting' : dueLabel(row.dueAt, now)
    case 'lost':
      return 'not delivered'
    case 'popped':
      return 'popped up'
    case 'seen':
      return 'seen'
    case 'typing':
      return 'typing'
    case 'replied':
      return 'reply'
    case 'done':
      return 'done'
    case 'snoozed':
      return snoozeLabel(row.snoozedUntil, now)
  }
}

/** Full text for screen readers, where the visible word alone is a bare time. */
export function spokenFor(kind: Kind, row: Pick<Row, 'dueAt' | 'snoozedUntil'>, now: number) {
  const word = wordFor(kind, row, now)
  if (kind === 'waiting' && row.dueAt !== null) return `waiting, ${word}`
  if (kind === 'snoozed') return `snoozed, ${word}`
  if (kind === 'lost') return "not delivered, their Mac stayed off"
  return word
}
