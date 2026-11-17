import { aadFor, open, sealEnvelopes } from './seal'
import type { Envelope, Kind, PrivateKey, Sealed } from './seal'
import type { Repeat } from './time'
import type { Urgency } from './tasks'

// Shapes from docs/device-api.md (contacts.list, messages.send, messages.mine).

export type DeviceInfo = { deviceId: string; kind: 'mac' | 'web'; publicKey: string }
export type MyDevice = DeviceInfo & { name: string; createdAt: number; lastSeen: number }
export type Contact = {
  userId: string
  name: string
  hasMac: boolean
  online: boolean
  macLastSeen: number | null
  devices: DeviceInfo[]
}
export type ContactsView =
  | { status: 'signedOut' }
  | { status: 'notMember' }
  | { status: 'member'; me: { userId: string; name: string; devices: MyDevice[] }; contacts: Contact[] }

export type SentRow = {
  ref: string
  fromUserId: string
  toUserId: string
  toName: string
  fromAgent: string | null
  forAgent: boolean
  urgency: Urgency
  dueAt: number
  repeat: string | null
  createdAt: number
  status: 'queued' | 'waiting' | 'popped' | 'seen' | 'replied' | 'done' | 'snoozed'
  statusAt: number
  snoozedUntil: number | null
  typingUntil: number | null
  title: Sealed | null
  reply: Sealed | null
  replyAt: number | null
}
export type MineView = { status: 'signedOut' } | { status: 'notMember' } | { status: 'member'; deviceActive: boolean; rows: SentRow[] }

export type SendArgs = {
  ref: string
  to: string
  forAgent: boolean
  urgency: Urgency
  dueAt?: number
  repeat?: Repeat
  envelopes: Envelope[]
  titleEnvelopes: Envelope[]
}
export type SendReply = { ok: true; ref: string } | { ok: false; error: string; devices?: DeviceInfo[]; myDevices?: DeviceInfo[] }

/** A Mac counts as online when it checked in during the last 12 minutes (same rule as the server). */
export const ONLINE_MS = 12 * 60_000

export function isOnline(macLastSeen: number | null | undefined, now: number) {
  return typeof macLastSeen === 'number' && now - macLastSeen < ONLINE_MS
}

function unique(devices: { deviceId: string; publicKey: string }[]) {
  const seen = new Set<string>()
  return devices.filter((d) => (seen.has(d.deviceId) ? false : (seen.add(d.deviceId), true)))
}

/**
 * Seals the text and sends it. Pings go to every active Mac of the recipient; the sender's copy to
 * all of the sender's devices plus this browser (the contact list may not know it yet).
 * On "stale-devices" it seals again for the lists the server returned and retries once, same ref.
 */
export async function sendSealed(
  send: (args: SendArgs) => Promise<SendReply>,
  p: {
    text: string
    ref: string
    from: string
    to: string
    forAgent: boolean
    urgency: Urgency
    dueAt?: number
    repeat?: Repeat
    recipientDevices: DeviceInfo[]
    myDevices: DeviceInfo[]
    own?: { deviceId: string; publicKey: string } | null
  },
): Promise<SendReply> {
  const aad = aadFor({ kind: 'title', ref: p.ref, from: p.from, to: p.to })
  const build = async (recipient: DeviceInfo[], mine: { deviceId: string; publicKey: string }[]): Promise<SendArgs> => ({
    ref: p.ref,
    to: p.to,
    forAgent: p.forAgent,
    urgency: p.urgency,
    ...(p.forAgent ? {} : { dueAt: p.dueAt, repeat: p.repeat }),
    envelopes: await sealEnvelopes(unique(recipient.filter((d) => d.kind === 'mac')), p.text, aad),
    titleEnvelopes: await sealEnvelopes(unique(mine), p.text, aad),
  })
  const first = await send(await build(p.recipientDevices, [...(p.own ? [p.own] : []), ...p.myDevices]))
  if (first.ok || first.error !== 'stale-devices') return first
  // The server's lists are the truth now: if this browser was revoked, it is not in them.
  const mine = first.myDevices ?? [...(p.own ? [p.own] : []), ...p.myDevices]
  return send(await build(first.devices ?? p.recipientDevices, mine))
}

/** Opens one sealed text of a sent row. Null when it is not for this key (another device) or damaged. */
export async function openRow(privateKey: PrivateKey, row: Pick<SentRow, 'ref' | 'fromUserId' | 'toUserId'>, kind: Kind, sealed: Sealed): Promise<string | null> {
  try {
    // Sender and recipient stay in place for both kinds: a reply does not swap them.
    return await open(privateKey, sealed, aadFor({ kind, ref: row.ref, from: row.fromUserId, to: row.toUserId }))
  } catch {
    return null
  }
}
