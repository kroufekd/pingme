import { useAuthActions } from '@convex-dev/auth/react'
import { useConvexAuth, useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { clearInvite, loadInvite, loadOtpEmail, saveOtpEmail } from '@/lib/invite'
import { isOnline } from '@/lib/network'
import type { ContactsView, MyDevice } from '@/lib/network'
import type { Me } from '@/lib/tasks'
import { useNow } from '@/lib/time'
import { ConnectAgent } from './connect'
import { Icon } from './icon'
import { NewMacNotice, useDeviceList } from './devices'
import { ContactNews, NoMacNotice } from './notices'
import { Onboarding, needsOnboarding } from './onboarding'
import { PairPanel } from './pair'
import { ME } from './people-picker'
import type { Person } from './people-picker'
import { CodePanel, EmailPanel } from './sign-in'
import type { Welcome } from './sign-in'
import { SentList, SentToggle, hasUnseenReply } from './task-list'
import { TaskForm } from './task-form'
import { useDevice, useSent } from './use-network'

type Phase = 'loading' | 'email' | 'code' | 'form'
const NO_DEVICES: MyDevice[] = []

const HINT_NO_CODE = "Couldn't send a code to this email."
const HINT_DEAD_LINK = 'No invite for this email. Ask for a new link.'
const HINT_NOT_MEMBER = 'This email has no invite.'
const HINT_BAD_EMAIL = 'Check the email.'
const HINT_BAD_CODE = "That code doesn't match."

/**
 * The one screen. Sign-in states first; signed in, "home" shows the form and the sent list,
 * "pair" (the /pair page the Mac opens) shows the pairing confirmation in the same place.
 */
export function App({ view = 'home' }: { view?: 'home' | 'pair' }) {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const { signIn, signOut } = useAuthActions()
  const startInvite = useMutation(api.inviteLinks.start)
  const claimInvite = useMutation(api.inviteLinks.claim)
  const finishOnboarding = useMutation(api.senders.finishOnboarding)

  const [mounted, setMounted] = useState(false)
  const [invite, setInvite] = useState<string | null>(null)
  const [otpEmail, setOtpEmail] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [emailHint, setEmailHint] = useState<string | null>(null)
  const [codeHint, setCodeHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [claim, setClaim] = useState<'idle' | 'pending' | 'done'>('idle')
  // An existing member opened someone's invite: who asks to be a contact, until they say yes or no.
  const [askAdd, setAskAdd] = useState<string | null>(null)

  useEffect(() => {
    setInvite(loadInvite())
    const pending = loadOtpEmail()
    if (pending) {
      setOtpEmail(pending)
      setEmail(pending)
    }
    setMounted(true)
  }, [])

  const forgetInvite = useCallback(() => {
    clearInvite()
    setInvite(null)
  }, [])

  const me: Me | undefined = useQuery(api.senders.me, mounted && isAuthenticated ? {} : 'skip')
  const check = useQuery(api.inviteLinks.check, mounted && invite && !isAuthenticated ? { token: invite } : 'skip')

  // A dead link (invalid, expired, used): plain email sign-in, and a line that says why.
  const [deadInvite, setDeadInvite] = useState(false)
  useEffect(() => {
    if (check && !check.ok) {
      setDeadInvite(true)
      forgetInvite()
    }
  }, [check, forgetInvite])
  const welcome: Welcome | null = check?.ok
    ? { kind: 'invited', inviter: check.inviterName }
    : deadInvite
      ? { kind: 'dead' }
      : invite
        ? null
        : { kind: 'plain' }

  // Signed in: the code step is over.
  useEffect(() => {
    if (!isAuthenticated) {
      setClaim('idle')
      return
    }
    if (otpEmail) {
      setOtpEmail(null)
      saveOtpEmail(null)
    }
  }, [isAuthenticated, otpEmail])

  // Signed in with a link in hand: claim it. The token stays until the claim says ok.
  useEffect(() => {
    if (!isAuthenticated || !invite || claim !== 'idle') return
    setClaim('pending')
    claimInvite({ token: invite })
      .then((res) => {
        if (res.ok || res.error === 'bad-link') forgetInvite()
        else if (res.error === 'confirm') setAskAdd(res.inviterName)
      })
      .catch(() => {})
      .finally(() => setClaim('done'))
  }, [isAuthenticated, invite, claim, claimInvite, forgetInvite])

  // Signed in but not one of the senders: back to the email state, signed out.
  const leaving = mounted && isAuthenticated && me !== undefined && me.status !== 'member' && !(invite && claim !== 'done')
  const leavingRef = useRef(false)
  useEffect(() => {
    if (!leaving || leavingRef.current || me === undefined) return
    leavingRef.current = true
    if (me.status === 'notMember') {
      setEmail(me.email)
      setEmailHint(HINT_NOT_MEMBER)
    }
    signOut().finally(() => {
      leavingRef.current = false
    })
  }, [leaving, me, signOut])

  let phase: Phase = 'loading'
  if (mounted && !isLoading) {
    if (!isAuthenticated) phase = otpEmail ? 'code' : 'email'
    else if (me?.status === 'member') phase = 'form'
  }
  // While something loads, the screen keeps showing what it showed (code -> form without a blank).
  const lastShown = useRef<Phase>('loading')
  if (phase !== 'loading') lastShown.current = phase
  const shown = phase === 'loading' ? lastShown.current : phase
  const waiting = phase === 'loading'

  useEffect(() => {
    setBusy(false)
  }, [phase])

  // The network (device key, contacts, sent list) only runs on the home view of a member.
  const network = view === 'home' && phase === 'form'
  const device = useDevice(network)
  const contacts = useQuery(api.contacts.list, network ? {} : 'skip') as ContactsView | undefined
  // The online dot comes from macLastSeen on this timer: a query does not rerun as time passes.
  const now = useNow(30_000)
  const sent = useSent({ enabled: network, device, view: contacts, now })
  const contactList = contacts?.status === 'member' ? contacts.contacts : null
  const myDevices = contacts?.status === 'member' ? contacts.me.devices : null
  // "Connect your agent" and "Devices" share one row and open one at a time.
  const [drawer, setDrawer] = useState<'agent' | 'devices' | null>(null)
  const deviceList = useDeviceList(myDevices ?? NO_DEVICES, device.deviceId, now, drawer === 'devices', (o) => setDrawer(o ? 'devices' : null))
  const meView = contacts?.status === 'member' ? contacts.me : null
  const people: Person[] | null = useMemo(() => {
    if (!contactList || !meView) return null
    const list: Person[] = contactList.map((c) => ({ userId: c.userId, name: c.name, hasMac: c.hasMac, online: isOnline(c.macLastSeen, now) }))
    // You, last: a ping to yourself (or your agent) lands on your own Mac. Only with a Mac to land on.
    const macs = meView.devices.filter((d) => d.kind === 'mac')
    if (macs.length) list.push({ userId: meView.userId, name: ME, self: true, hasMac: true, online: isOnline(Math.max(...macs.map((d) => d.lastSeen)), now) })
    return list
  }, [contactList, meView, now])

  async function sendCode(address: string) {
    setBusy(true)
    setEmailHint(null)
    setEmail(address)
    try {
      if (invite) {
        const res = await startInvite({ token: invite, email: address })
        if (!res.ok && res.error === 'bad-email') {
          setEmailHint(HINT_BAD_EMAIL)
          setBusy(false)
          return
        }
        if (!res.ok) forgetInvite()
      }
      await signIn('resend-otp', { email: address })
      saveOtpEmail(address)
      setCodeHint(null)
      setOtpEmail(address)
    } catch {
      // Not on the list, or the code could not be sent. Same quiet answer, unless the link was dead.
      setEmailHint(deadInvite ? HINT_DEAD_LINK : HINT_NO_CODE)
      setBusy(false)
    }
  }

  async function verify(code: string) {
    if (!otpEmail) return false
    setBusy(true)
    setCodeHint(null)
    try {
      const res = await signIn('resend-otp', { email: otpEmail, code })
      if (!res.signingIn) throw new Error('code')
      return true
    } catch {
      setCodeHint(HINT_BAD_CODE)
      setBusy(false)
      return false
    }
  }

  function backToEmail() {
    saveOtpEmail(null)
    setOtpEmail(null)
    setCodeHint(null)
    setEmailHint(null)
  }

  // The sent list is closed until asked for. A waiting reply only puts a badge on its icon.
  const [listOpen, setListOpen] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Right after signing in, the keyboard lands in the title field (not on a plain page load).
  const prevShown = useRef<Phase>('loading')
  useEffect(() => {
    if (shown === 'form' && prevShown.current === 'code') formRef.current?.querySelector<HTMLInputElement>('#u-title')?.focus()
    prevShown.current = shown
  }, [shown])

  // Initials on each sent row only when the pings went to more than one person.
  const showWho = (contactList?.length ?? 0) > 1 || new Set(sent.rows.map((r) => r.toName).filter(Boolean)).size > 1
  const home = view === 'home'
  const listReady = home && shown === 'form' && sent.loaded
  // The intro names who invited them (or their first contact) and waits for that, so no name flashes.
  const introName = me?.status === 'member' ? (me.inviterName ?? contactList?.[0]?.name) : undefined
  return (
    <main className="screen">
      <h1 className="vh">pingme</h1>
      <div className="notices">
        {/* A Mac that joins the account can read every ping to it: never let that pass unseen. */}
        {home && shown === 'form' && myDevices && <NewMacNotice devices={myDevices} thisId={device.deviceId} now={now} />}
        {home && shown === 'form' && askAdd && invite && (
          <ContactRequest
            name={askAdd}
            onAnswer={async (yes) => {
              if (yes) {
                const res = await claimInvite({ token: invite, addContact: true })
                if (!res.ok && res.error !== 'bad-link') return
              }
              setAskAdd(null)
              forgetInvite()
            }}
          />
        )}
        {home && shown === 'form' && contactList && <ContactNews contacts={contactList} />}
        {home && shown === 'form' && myDevices && !myDevices.some((d) => d.kind === 'mac') && <NoMacNotice onSetUp={() => setDrawer('agent')} />}
      </div>
      <div className="stage" data-phase={shown} aria-busy={waiting || busy || undefined}>
        <EmailPanel on={shown === 'email'} busy={busy || waiting} hint={emailHint} initialEmail={email} welcome={welcome} onSubmit={(a) => void sendCode(a)} />
        <CodePanel on={shown === 'code'} busy={busy || waiting} hint={codeHint} email={otpEmail ?? ''} onSubmit={verify} onBack={backToEmail} />
        {home ? (
          <TaskForm
            on={shown === 'form'}
            people={people}
            onSend={sent.send}
            panelRef={formRef}
            aside={
              <SentToggle
                count={listReady ? sent.rows.length : 0}
                badge={listReady && !listOpen && hasUnseenReply(sent.rows)}
                open={listOpen}
                onToggle={() => setListOpen((o) => !o)}
              />
            }
          />
        ) : (
          <PairPanel on={shown === 'form'} />
        )}
      </div>
      {listReady && <SentList rows={sent.rows} keyOf={sent.keyOf} onAck={sent.onAck} open={listOpen} showWho={showWho} />}
      {listReady && (
        <ConnectAgent
          open={drawer === 'agent'}
          onOpenChange={(o) => setDrawer(o ? 'agent' : null)}
          side={myDevices && deviceList.toggle}
          below={myDevices && deviceList.panel}
        />
      )}
      {/* Once per account, after the contacts are known. The text is end-to-end encrypted. */}
      {home && shown === 'form' && contactList !== null && needsOnboarding(me) && (
        <Onboarding
          name={introName}
          encrypted
          onDone={() => void finishOnboarding({}).catch(() => {})}
          onClosed={() => formRef.current?.querySelector<HTMLInputElement>('#u-title')?.focus()}
        />
      )}
    </main>
  )
}

export const ADD_CONTACT = (name: string) => `Add ${name} to your contacts?`

/**
 * Someone's invite reached a person who is already a member. Nothing happens until they answer:
 * a link that adds its sender to your contacts on open would let anyone who knows your email in.
 */
export function ContactRequest({ name, onAnswer }: { name: string; onAnswer: (yes: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  async function answer(yes: boolean) {
    if (busy) return
    setBusy(true)
    try {
      await onAnswer(yes)
    } catch {
      // Offline: the question stays, so it can be answered again.
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="dv-new" role="group" aria-label={ADD_CONTACT(name)}>
      <span className="dv-new-i">
        <Icon name="user" size={18} />
      </span>
      <p className="dv-new-t">
        <span>Add</span> <b>{name}</b> <span>to your contacts?</span>
      </p>
      <span className="dv-new-a">
        <button type="button" className="chip" onClick={() => void answer(true)} disabled={busy}>
          Add
        </button>
        <button type="button" className="chip" onClick={() => void answer(false)} disabled={busy}>
          No
        </button>
      </span>
    </div>
  )
}
