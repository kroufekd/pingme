import { aadFor, generateKeyPair, newRef, open, seal } from '@/lib/seal'
import type { Kind, Sealed } from '@/lib/seal'
import type { Contact, ContactsView, SentRow } from '@/lib/network'

// Network fixtures for the app tests: real keys, real HPKE, fake ids.

export type Keys = { publicKey: string; privateKey: string }
export const ME = 'u-me'
export const DOMINIK = 'u-dom'
export const VIKI = 'u-viki'
export const WEB = 'web1'

export async function keys() {
  return {
    me: await generateKeyPair(),
    myMac: await generateKeyPair(),
    dominikMac: await generateKeyPair(),
    vikiMac: await generateKeyPair(),
    stranger: await generateKeyPair(),
  }
}

export function contact(over: Partial<Contact> & { userId: string; name: string }, macKey?: Keys, macId = `mac-${over.userId}`): Contact {
  const hasMac = !!macKey
  return {
    hasMac,
    online: hasMac,
    macLastSeen: hasMac ? Date.now() - 30_000 : null,
    devices: macKey ? [{ deviceId: macId, kind: 'mac', publicKey: macKey.publicKey }] : [],
    ...over,
  }
}

export function contactsView(myKey: Keys, contacts: Contact[], myMac?: Keys): ContactsView {
  const now = Date.now()
  return {
    status: 'member',
    me: {
      userId: ME,
      name: 'Franta',
      devices: [
        { deviceId: WEB, kind: 'web', publicKey: myKey.publicKey, name: 'Chrome · Mac', createdAt: now, lastSeen: now },
        ...(myMac ? [{ deviceId: 'mac-me', kind: 'mac' as const, publicKey: myMac.publicKey, name: 'MacBook', createdAt: now, lastSeen: now }] : []),
      ],
    },
    contacts,
  }
}

export async function sealFor(publicKey: string, kind: Kind, ref: string, text: string, to = DOMINIK): Promise<Sealed> {
  return seal(publicKey, text, aadFor({ kind, ref, from: ME, to }))
}

export async function openFor(privateKey: string, kind: Kind, ref: string, sealed: Sealed, to = DOMINIK) {
  return open(privateKey, sealed, aadFor({ kind, ref, from: ME, to }))
}

/** A sent row as messages.mine returns it, with the title (and reply) sealed for `forKey`. */
export async function sentRow(
  forKey: Keys,
  over: Partial<SentRow> & { text?: string | null; replyText?: string } = {},
): Promise<SentRow> {
  const { text = 'Pošli mi fotky z hor', replyText, ...rest } = over
  const ref = rest.ref ?? newRef()
  const now = Date.now()
  const to = rest.toUserId ?? DOMINIK
  return {
    ref,
    fromUserId: ME,
    toUserId: to,
    toName: 'Dominik',
    fromAgent: null,
    forAgent: false,
    urgency: 'orange',
    dueAt: now,
    repeat: null,
    createdAt: now,
    status: 'queued',
    statusAt: now,
    undelivered: false,
    snoozedUntil: null,
    typingUntil: null,
    title: text === null ? null : await sealFor(forKey.publicKey, 'title', ref, text, to),
    reply: replyText === undefined ? null : await sealFor(forKey.publicKey, 'reply', ref, replyText, to),
    replyAt: replyText === undefined ? null : now,
    ...rest,
  }
}
