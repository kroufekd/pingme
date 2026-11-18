import { useMutation, useQuery } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { parsePairHash, secretHash } from '@/lib/pair'
import { CODE_LENGTH, CODE_SHORT, cleanCode } from '@/lib/validate'
import { Icon } from './icon'
import { useNudge } from './sign-in'

export const PAIR_TITLE = 'Connect this Mac'
export const PAIR_CODE = 'Code from your Mac'
// A link and a code from a message are how someone else's Mac gets onto your account.
export const PAIR_WARN = "Don't see this code on your Mac? Don't connect."
export const PAIR_TO = 'This Mac joins'
const DONE = 'Connected'
const INVALID = 'This link has expired.'
const FAILED = "That didn't work. Try again."
const BAD_CODE = "That code doesn't match."

type Target = { pairId: string; secretHash: string }
type Pairing = { status: 'signedOut' } | { status: 'notMember' } | { status: 'invalid' } | { status: 'pending'; name: string; expiresAt: number } | { status: 'approved' }

/**
 * /pair#<pairId>.<secret>, opened by the Mac app. Shown once the member is signed in: the Mac's
 * name, the six digits its island shows, one button. The code proves the Mac is in front of
 * you, so a link someone sent you cannot add their Mac to your account. "Done" is latched here,
 * because the request turns "invalid" once it expires.
 */
export function PairPanel({ on, account }: { on: boolean; /** The account this Mac joins, said before the code is typed. */ account?: string }) {
  // undefined: still reading the address, null: no usable link in it.
  const [target, setTarget] = useState<Target | null | undefined>(undefined)
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [code, setCode] = useState('')
  const lastName = useRef<string | null>(null)
  const codeRef = useRef<HTMLInputElement>(null)
  const { cls: nudgeCls, nudge } = useNudge()
  const approve = useMutation(api.devices.approvePairing)

  // The fragment only exists in the browser, and hashing is async: both after mount. A new link
  // pasted into this same tab only changes the fragment, so start over on hashchange. Clearing
  // the fragment after success uses replaceState, which fires no hashchange.
  useEffect(() => {
    let alive = true
    let seq = 0
    function read() {
      const n = ++seq
      setDone(false)
      setRefused(false)
      setCode('')
      setNote(null)
      lastName.current = null
      const parsed = parsePairHash(window.location.hash)
      if (!parsed) {
        setTarget(null)
        return
      }
      setTarget(undefined)
      secretHash(parsed.secret)
        .then((h) => alive && n === seq && setTarget({ pairId: parsed.pairId, secretHash: h }))
        .catch(() => alive && n === seq && setTarget(null))
    }
    read()
    window.addEventListener('hashchange', read)
    return () => {
      alive = false
      window.removeEventListener('hashchange', read)
    }
  }, [])

  const pairing = useQuery(api.devices.pairing, on && target && !done && !refused ? target : 'skip') as Pairing | undefined
  if (pairing?.status === 'pending') lastName.current = pairing.name

  let state: 'loading' | 'pending' | 'done' | 'invalid' = 'loading'
  if (done || pairing?.status === 'approved') state = 'done'
  else if (target === null || refused || pairing?.status === 'invalid') state = 'invalid'
  else if (pairing?.status === 'pending') state = 'pending'

  // The code is the only thing to do here.
  useEffect(() => {
    if (on && state === 'pending') codeRef.current?.focus()
  }, [on, state])

  function wrong(text: string) {
    setNote(text)
    nudge()
    codeRef.current?.focus()
  }

  async function confirm() {
    if (!target || busy) return
    if (code.length !== CODE_LENGTH) return wrong(CODE_SHORT)
    setBusy(true)
    setNote(null)
    try {
      const res = await approve({ ...target, code })
      if (res.ok) {
        setDone(true)
        // The secret has done its job; keep it out of the history and of a reload.
        try {
          window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
        } catch {
          // The address keeps the fragment; the request is approved anyway.
        }
      } else if (res.error === 'bad-code') {
        setCode('')
        wrong(BAD_CODE)
      } else setRefused(true)
    } catch {
      setNote(FAILED)
    } finally {
      setBusy(false)
    }
  }

  const name = lastName.current
  return (
    <section
      className={['ps', 'pp', on ? 'on' : '', state, note ? 'bad' : ''].filter(Boolean).join(' ')}
      inert={!on}
      aria-hidden={!on || undefined}
      aria-label={PAIR_TITLE}
      aria-busy={state === 'loading' || busy || undefined}
    >
      <p className="ps-note" id="u-pair-note" role="status" aria-live="polite">
        {note}
      </p>
      <div className={`line pp-line ${nudgeCls}`.trim()}>
        <span className="pp-i">
          <Icon name={state === 'done' ? 'check' : 'laptop'} size={24} />
        </span>
        {state === 'loading' ? (
          <span className="it-ph pp-ph" aria-hidden="true" />
        ) : state === 'invalid' ? (
          <p className="pp-name quiet">{INVALID}</p>
        ) : (
          <p className="pp-name">{name ?? 'Mac'}</p>
        )}
      </div>
      {state === 'pending' ? (
        <form
          className="tools pp-tools"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void confirm()
          }}
        >
          <input
            ref={codeRef}
            className="chip pp-code"
            name="pair-code"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            spellCheck={false}
            placeholder={PAIR_CODE}
            aria-label={PAIR_CODE}
            aria-invalid={note ? true : undefined}
            aria-describedby="u-pair-note u-pair-warn"
            value={code}
            readOnly={busy}
            onChange={(e) => {
              setCode(cleanCode(e.target.value))
              setNote(null)
            }}
          />
          <button type="submit" className="ob-ok pp-ok" disabled={busy} aria-busy={busy || undefined}>
            {PAIR_TITLE}
          </button>
          <p className="pp-warn" id="u-pair-warn">
            {account && (
              <>
                {PAIR_TO} <b>{account}</b>.{' '}
              </>
            )}
            <span>{PAIR_WARN}</span>
          </p>
        </form>
      ) : (
        <div className="tools pp-tools">
          {state === 'done' && (
            <>
              <p className="pp-done" role="status">
                {DONE}
              </p>
              <a className="pp-home" href="/" aria-label="Back to pingme" title="pingme">
                <Icon name="arrow-left" size={16} />
                <span>pingme</span>
              </a>
            </>
          )}
        </div>
      )}
    </section>
  )
}
