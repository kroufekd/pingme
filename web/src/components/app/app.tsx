import { useAuthActions } from '@convex-dev/auth/react'
import { useConvexAuth, useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { clearInvite, loadInvite, loadOtpEmail, saveOtpEmail } from '@/lib/invite'
import type { Me, Mine, Row } from '@/lib/tasks'
import { CodePanel, EmailPanel } from './sign-in'
import { SentList, SentToggle, hasUnseenReply } from './task-list'
import { TaskForm } from './task-form'
import type { NewTask, SendResult } from './task-form'

type Phase = 'loading' | 'email' | 'code' | 'form'

const HINT_NO_CODE = 'Na tenhle e-mail kód nepřijde.'
const HINT_NOT_MEMBER = 'Tenhle e-mail nemá pozvánku.'
const HINT_BAD_EMAIL = 'Zkontroluj e-mail.'
const HINT_BAD_CODE = 'Kód nesedí.'

/** Tells the Mac someone is looking, so it shares its list while the page is open. */
function useWatching(enabled: boolean) {
  const ping = useMutation(api.relay.ping)
  useEffect(() => {
    if (!enabled) return
    const beat = () => {
      if (document.visibilityState === 'visible') ping({}).catch(() => {})
    }
    beat()
    const id = setInterval(beat, 20_000)
    document.addEventListener('visibilitychange', beat)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', beat)
    }
  }, [enabled, ping])
}

type Local = { key: string; row: Row; id?: string }

/** Sending with an optimistic row that keeps its key when the real row arrives. */
function useSent(member: boolean) {
  const create = useMutation(api.relay.create)
  const mine: Mine | undefined = useQuery(api.tasks.mine, member ? {} : 'skip')
  const seq = useRef(0)
  const [locals, setLocals] = useState<Local[]>([])
  const [keys, setKeys] = useState<Record<string, string>>({})

  const send = useCallback(
    async (task: NewTask): Promise<SendResult> => {
      seq.current += 1
      const key = `local-${seq.current}`
      const now = Date.now()
      const row: Row = {
        taskRef: key,
        title: task.title,
        urgency: task.urgency,
        to: task.to,
        dueAt: task.dueAt,
        repeat: task.repeat,
        status: 'queued',
        statusAt: now,
        replyPending: false,
        createdAt: now,
      }
      setLocals((l) => [{ key, row }, ...l])
      try {
        const res = await create({ title: task.title, dueAt: task.dueAt, repeat: task.repeat, urgency: task.urgency, to: task.to === 'agent' ? 'agent' : undefined })
        if (res.ok) {
          setKeys((k) => ({ ...k, [res.id]: key }))
          setLocals((l) => l.map((x) => (x.key === key ? { ...x, id: res.id } : x)))
          return { ok: true }
        }
        setLocals((l) => l.filter((x) => x.key !== key))
        return { ok: false, error: res.error }
      } catch {
        setLocals((l) => l.filter((x) => x.key !== key))
        return { ok: false, error: 'network' }
      }
    },
    [create],
  )

  const serverRows = mine?.status === 'member' ? mine.rows : []
  const known = new Set(serverRows.map((r) => r.taskRef))
  const rows = [...locals.filter((l) => !(l.id && known.has(l.id))).map((l) => l.row), ...serverRows]
  const keyOf = useCallback((r: Row) => keys[r.taskRef] ?? r.taskRef, [keys])

  // Drop optimistic rows once the server has them (their key stays mapped).
  const matched = locals.some((l) => l.id && known.has(l.id))
  useEffect(() => {
    if (matched) setLocals((l) => l.filter((x) => !(x.id && known.has(x.id))))
  })

  return { loaded: mine !== undefined, rows, keyOf, send }
}

export function App() {
  const { isLoading, isAuthenticated } = useConvexAuth()
  const { signIn, signOut } = useAuthActions()
  const startInvite = useMutation(api.inviteLinks.start)
  const claimInvite = useMutation(api.inviteLinks.claim)
  const ackReply = useMutation(api.tasks.ackReply)

  const [mounted, setMounted] = useState(false)
  const [invite, setInvite] = useState<string | null>(null)
  const [otpEmail, setOtpEmail] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [emailHint, setEmailHint] = useState<string | null>(null)
  const [codeHint, setCodeHint] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [claim, setClaim] = useState<'idle' | 'pending' | 'done'>('idle')

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

  // A dead link (invalid, expired, used): plain email sign-in, same screen.
  useEffect(() => {
    if (check && !check.ok) forgetInvite()
  }, [check, forgetInvite])

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

  const sent = useSent(phase === 'form')
  useWatching(phase === 'form')

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
      // Not on the list, or the code could not be sent. Same quiet answer.
      setEmailHint(HINT_NO_CODE)
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

  const onAck = useCallback((taskRef: string) => ackReply({ taskRef }), [ackReply])

  // The sent list is closed until asked for. A waiting reply only puts a badge on its icon.
  const [listOpen, setListOpen] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  // Right after signing in, the keyboard lands in the title field (not on a plain page load).
  const prevShown = useRef<Phase>('loading')
  useEffect(() => {
    if (shown === 'form' && prevShown.current === 'code') formRef.current?.querySelector<HTMLInputElement>('#u-title')?.focus()
    prevShown.current = shown
  }, [shown])

  const listReady = shown === 'form' && sent.loaded
  return (
    <main className="screen">
      <h1 className="vh">pingme</h1>
      <div className="stage" data-phase={shown} aria-busy={waiting || busy || undefined}>
        <EmailPanel on={shown === 'email'} busy={busy || waiting} hint={emailHint} initialEmail={email} onSubmit={(a) => void sendCode(a)} />
        <CodePanel on={shown === 'code'} busy={busy || waiting} hint={codeHint} email={otpEmail ?? ''} onSubmit={verify} onBack={backToEmail} />
        <TaskForm
          on={shown === 'form'}
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
      </div>
      {listReady && <SentList rows={sent.rows} keyOf={sent.keyOf} onAck={onAck} open={listOpen} />}
    </main>
  )
}
