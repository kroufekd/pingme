import { useAction, useMutation, useQuery } from 'convex/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { isOnline } from '@/lib/network'
import type { Contact } from '@/lib/network'
import { slot } from './connect'
import { Icon } from './icon'

export const PEOPLE = 'People'
export const ONLINE = 'Online'
export const NO_APP = 'No Mac app'
export const REMOVE = 'Remove'
export const TAKE_BACK = 'Take back'
export const INVITE = 'Invite someone'
export const THEIR_NAME = 'Their name'
export const CREATE_LINK = 'Create link'
export const COPY_LINK = 'Copy link'
export const COPIED = 'Copied'
export const LINK_ONCE = 'Works once, for 7 days. Copy it now: it is not shown again.'
export const WAITING = 'Invited, not joined yet'
const DONE = 'Done'
const NOBODY = 'No contacts yet. Invite someone below.'
const ARM_MS = 4000
const MAX_NAME = 60

export const CREATE_ERRORS = {
  'not-member': 'Sign in again to invite.',
  'bad-name': `Type their name, up to ${MAX_NAME} characters.`,
  'too-many-invites': 'Too many links are waiting. Take one back first.',
  'rate-limited': 'That is a lot of links this hour. Try again later.',
} as const
const FAILED = "That didn't work. Try again."

type Invite = { inviteId: string; name: string; email: string | null; createdAt: number; expiresAt: number }
type Created = { inviteId: string; name: string; url: string }

const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'numeric' })
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/** How a contact can be reached right now, for their row. */
export function contactStatus(c: Contact, now: number): { on: boolean; text: string } {
  if (!c.hasMac) return { on: false, text: NO_APP }
  if (isOnline(c.macLastSeen, now)) return { on: true, text: ONLINE }
  if (c.macLastSeen === null) return { on: false, text: 'Mac off' }
  return { on: false, text: `Seen ${sameDay(c.macLastSeen, now) ? 'today' : day(c.macLastSeen)}` }
}

/**
 * The people you can ping, the links you sent that nobody used yet, and a way to invite someone.
 * Shaped like the device list: the toggle sits in the row of "Connect your agent" and the panel
 * opens under it. An invite link exists only as a hash on the server, so the full link is shown
 * once, here, and kept in memory only: it is a key to your contacts and never touches storage.
 */
export function usePeopleList(contacts: Contact[], now: number, open: boolean, onOpenChange: (open: boolean) => void, enabled: boolean) {
  const removeContact = useMutation(api.contacts.remove)
  const revokeInvite = useMutation(api.inviteLinks.revoke)
  const createInvite = useAction(api.inviteLinks.create)
  const invites = useQuery(api.inviteLinks.mine, enabled ? {} : 'skip') as Invite[] | null | undefined

  // One slip must not drop a contact or kill a link: the first click arms, the second acts.
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const [copied, setCopied] = useState(false)
  const id = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const urlRef = useRef<HTMLParagraphElement>(null)
  // The new link leaves the screen once it was on the open list and is no longer: used or taken back.
  const listed = useRef(false)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])

  useEffect(() => {
    if (!open) setArmed(null)
  }, [open])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(t)
  }, [copied])

  useEffect(() => {
    if (!created || !invites) return
    if (invites.some((i) => i.inviteId === created.inviteId)) listed.current = true
    else if (listed.current) setCreated(null)
  }, [created, invites])

  useEffect(() => {
    if (created) copyRef.current?.focus()
  }, [created])

  // Reachable first, then by name: the people you can ping now are at the top.
  const sorted = useMemo(
    () =>
      [...contacts].sort((a, b) => {
        const ra = contactStatus(a, now).on ? 0 : a.hasMac ? 1 : 2
        const rb = contactStatus(b, now).on ? 0 : b.hasMac ? 1 : 2
        return ra - rb || a.name.localeCompare(b.name)
      }),
    [contacts, now],
  )
  const online = sorted.filter((c) => contactStatus(c, now).on).length
  const waiting = invites ?? []

  async function remove(key: string, act: () => Promise<unknown>) {
    if (armed !== key) {
      setArmed(key)
      return
    }
    if (busy) return
    setBusy(true)
    try {
      await act()
      // The row goes away with the next query result; keep the keyboard somewhere sensible.
      toggleRef.current?.focus()
    } catch {
      // Offline: the row stays, so it can be tried again.
    } finally {
      setArmed(null)
      setBusy(false)
    }
  }

  async function invite() {
    const clean = name.trim()
    if (!clean || clean.length > MAX_NAME) {
      setNote(CREATE_ERRORS['bad-name'])
      fieldRef.current?.focus()
      return
    }
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const res = await createInvite({ name: clean })
      if (!res.ok) {
        setNote(CREATE_ERRORS[res.error])
        return
      }
      listed.current = false
      setCopied(false)
      setCreated({ inviteId: res.inviteId, name: clean, url: res.url })
      setName('')
    } catch {
      setNote(FAILED)
    } finally {
      setBusy(false)
    }
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // No clipboard (http, old browser, denied): select the link for a manual copy.
      const el = urlRef.current
      const sel = window.getSelection?.()
      if (el && sel) {
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
  }

  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      className="cn-b dv-b"
      aria-expanded={open}
      aria-controls={id}
      aria-label={`${PEOPLE} ${contacts.length}${online ? `, ${online} ${ONLINE.toLowerCase()}` : ''}`}
      onClick={() => onOpenChange(!open)}
    >
      <span className="dv-b-i" aria-hidden="true">
        <Icon name="user" size={16} />
        {online > 0 && <span className="dv-b-dot" />}
      </span>
      <span className="dv-b-t" aria-hidden="true">
        {PEOPLE}
      </span>
      <span className="dv-n" aria-hidden="true">
        {contacts.length}
      </span>
    </button>
  )

  let i = 0
  const panel = (
    <div
      className={open ? 'rv dv-p on' : 'rv dv-p'}
      id={id}
      inert={!open}
      aria-hidden={!open || undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        onOpenChange(false)
        toggleRef.current?.focus()
      }}
    >
      <div className="rv-c">
        <div className="rv-card dv-card pp-card">
          <ul className="dv-list" aria-label={PEOPLE}>
            {sorted.length === 0 && (
              <li className="dv-none rv-i" style={slot(i++)}>
                {NOBODY}
              </li>
            )}
            {sorted.map((c) => {
              const key = `c:${c.userId}`
              const on = armed === key
              const status = contactStatus(c, now)
              return (
                <li key={key} className="dv-row rv-i" style={slot(i++)}>
                  <span className="dv-row-i">
                    <Icon name="user" size={18} />
                  </span>
                  <span className="dv-name">{c.name}</span>
                  <span className={status.on ? 'dv-st on' : 'dv-st'}>
                    <span className="dv-dot" aria-hidden="true" />
                    {status.text}
                  </span>
                  <span className="dv-act">
                    <button
                      type="button"
                      className={on ? 'chip dv-rm on' : 'chip dv-rm'}
                      onClick={() => void remove(key, () => removeContact({ userId: c.userId }))}
                      disabled={busy}
                      aria-label={on ? `Confirm: ${REMOVE} ${c.name}` : `${REMOVE} ${c.name}`}
                      title={REMOVE}
                    >
                      {on ? <span>{REMOVE}</span> : <Icon name="x" size={16} />}
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>

          {waiting.length > 0 && (
            <ul className="dv-list pp-wait" aria-label={WAITING}>
              {waiting.map((w) => {
                const key = `i:${w.inviteId}`
                const on = armed === key
                return (
                  <li key={key} className="dv-row rv-i" style={slot(i++)}>
                    <span className="dv-row-i">
                      <Icon name="link" size={18} />
                    </span>
                    <span className="dv-name">{w.name}</span>
                    <span className="dv-st pp-until" title={w.email ?? undefined}>
                      {w.email ?? `Until ${day(w.expiresAt)}`}
                    </span>
                    <span className="dv-act">
                      <button
                        type="button"
                        className={on ? 'chip dv-rm on' : 'chip dv-rm'}
                        onClick={() =>
                          void remove(key, async () => {
                            await revokeInvite({ inviteId: w.inviteId })
                            if (created?.inviteId === w.inviteId) setCreated(null)
                          })
                        }
                        disabled={busy}
                        aria-label={on ? `Confirm: ${TAKE_BACK} the link for ${w.name}` : `${TAKE_BACK} the link for ${w.name}`}
                        title={TAKE_BACK}
                      >
                        {on ? <span>{TAKE_BACK}</span> : <Icon name="x" size={16} />}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}

          <div className="pp-inv rv-i" style={slot(i++)}>
            {created ? (
              <div className="pp-new" role="group" aria-label={`Link for ${created.name}`}>
                <p className="pp-new-h">
                  Link for <b>{created.name}</b>
                </p>
                <p className="pp-url" ref={urlRef}>
                  {created.url}
                </p>
                <div className="pp-new-a">
                  <button ref={copyRef} type="button" className={copied ? 'chip pp-go ok' : 'chip pp-go'} onClick={() => void copy(created.url)}>
                    <Icon name={copied ? 'check' : 'copy'} size={16} />
                    <span aria-live="polite">{copied ? COPIED : COPY_LINK}</span>
                  </button>
                  <button
                    type="button"
                    className="chip pp-ghost"
                    onClick={() => {
                      setCreated(null)
                      fieldRef.current?.focus()
                    }}
                  >
                    {DONE}
                  </button>
                </div>
                <p className="pp-once">{LINK_ONCE}</p>
              </div>
            ) : (
              <form
                className="pp-form"
                noValidate
                onSubmit={(e) => {
                  e.preventDefault()
                  void invite()
                }}
              >
                <label className="pp-l" htmlFor={`${id}-name`}>
                  {INVITE}
                </label>
                <span className="pp-row">
                  <input
                    ref={fieldRef}
                    id={`${id}-name`}
                    className="chip pp-in"
                    placeholder={THEIR_NAME}
                    aria-invalid={note ? true : undefined}
                    aria-describedby={`${id}-note`}
                    maxLength={MAX_NAME}
                    autoComplete="off"
                    value={name}
                    readOnly={busy}
                    onChange={(e) => {
                      setName(e.target.value)
                      setNote(null)
                    }}
                  />
                  <button type="submit" className="chip pp-go" disabled={busy}>
                    {CREATE_LINK}
                  </button>
                </span>
              </form>
            )}
            <p className="ac-note" id={`${id}-note`} role="status" aria-live="polite">
              {note}
            </p>
          </div>
        </div>
      </div>
    </div>
  )

  return { toggle, panel }
}
