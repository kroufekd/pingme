import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CODE_LENGTH, CODE_SHORT, EMAIL_NOTES, checkEmail, cleanCode, suggestEmail } from '@/lib/validate'
import { Icon } from './icon'

/** Sign-in is the only thing to do on these states, so the field takes focus whenever its state turns on. */
function useFocusWhenShown(on: boolean, target: React.RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    if (on) target.current?.focus()
  }, [on, target])
}

/** A short shake of the input line. The class flips between two names so it replays without remounting. */
export function useNudge() {
  const [n, setN] = useState(0)
  return { cls: n === 0 ? '' : n % 2 ? 'nudge-a' : 'nudge-b', nudge: () => setN((x) => x + 1) }
}

function GoButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button type="submit" className="go" aria-label={label} title={label} aria-busy={busy || undefined} disabled={busy}>
      {busy ? <span className="spin" aria-hidden="true" /> : <Icon name="arrow-right" size={20} />}
    </button>
  )
}

export function EmailPanel({
  on,
  busy,
  hint,
  initialEmail,
  onSubmit,
}: {
  on: boolean
  busy: boolean
  /** What the server said about the last address (no invite, code not sent). */
  hint: string | null
  initialEmail: string
  onSubmit: (email: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [email, setEmail] = useState(initialEmail)
  // Quiet until the first failed submit, then the address is checked while typing.
  const [checking, setChecking] = useState(false)
  // The address a fix was offered for. Sending it again unchanged means "it is right".
  const [offeredFor, setOfferedFor] = useState<string | null>(null)
  // The server's hint is about the address that was sent; editing it puts the hint away.
  const [hintStale, setHintStale] = useState(false)
  const { cls: nudgeCls, nudge } = useNudge()
  useEffect(() => setEmail(initialEmail), [initialEmail])
  useEffect(() => {
    if (busy) setHintStale(false)
  }, [busy])
  useEffect(() => {
    if (hint) setHintStale(false)
  }, [hint])
  useFocusWhenShown(on, inputRef)

  const check = checkEmail(email)
  const fix = offeredFor !== null && check.ok && check.value === offeredFor ? suggestEmail(check.value) : null
  const error = checking && !check.ok ? EMAIL_NOTES[check.error] : null
  const serverHint = hint && !hintStale ? hint : null
  const note = error ?? serverHint

  function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (!check.ok) {
      setChecking(true)
      nudge()
      inputRef.current?.focus()
      return
    }
    // A likely typo holds the first submit and offers the fix. The second one goes as typed.
    if (offeredFor !== check.value && suggestEmail(check.value)) {
      setOfferedFor(check.value)
      return
    }
    onSubmit(check.value)
  }

  function takeFix(fixed: string) {
    setEmail(fixed)
    setOfferedFor(null)
    if (!busy) onSubmit(fixed)
  }

  const cls = ['ps', on ? 'on' : '', email.trim() ? 'has' : '', note ? 'bad' : ''].filter(Boolean).join(' ')
  return (
    <form className={cls} inert={!on} aria-hidden={!on || undefined} aria-label="Přihlášení e-mailem" onSubmit={submit} noValidate>
      <p className="ps-note" id="u-mail-hint" role="status" aria-live="polite">
        {note}
      </p>
      <label className="vh" htmlFor="u-mail">E-mail</label>
      <div className={`line ${nudgeCls}`.trim()}>
        <input
          ref={inputRef}
          className="pf-in"
          id="u-mail"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="E-mail"
          maxLength={200}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setHintStale(true)
          }}
          readOnly={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby="u-mail-hint"
        />
        <GoButton busy={busy} label="Poslat kód" />
      </div>
      <div className="tools">
        {fix && (
          <button type="button" className="ps-fix" onClick={() => takeFix(fix)} disabled={busy} aria-label={`Opravit na ${fix}`} title="Opravit">
            <Icon name="check" size={16} />
            <span aria-hidden="true">{fix}</span>
          </button>
        )}
      </div>
    </form>
  )
}

export function CodePanel({
  on,
  busy,
  hint,
  email,
  onSubmit,
  onBack,
}: {
  on: boolean
  busy: boolean
  /** What the server said about the last code (it did not match). */
  hint: string | null
  /** Where the code went; shown on the way back so a typo is easy to spot. */
  email: string
  /** Resolves false when the code was wrong, the field then clears. */
  onSubmit: (code: string) => Promise<boolean>
  onBack: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState('')
  const [short, setShort] = useState(false)
  // A wrong code stays marked until the next digit is typed.
  const [hintStale, setHintStale] = useState(false)
  const { cls: nudgeCls, nudge } = useNudge()
  useFocusWhenShown(on, inputRef)
  useEffect(() => {
    if (!on) {
      setCode('')
      setShort(false)
    }
  }, [on])
  useEffect(() => {
    if (!hint) return
    setHintStale(false)
    nudge()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hint])
  useEffect(() => {
    if (busy) setHintStale(false)
  }, [busy])

  async function send(value: string) {
    if (busy) return
    if (value.length !== CODE_LENGTH) {
      setShort(true)
      nudge()
      inputRef.current?.focus()
      return
    }
    const ok = await onSubmit(value)
    if (!ok) {
      setCode('')
      inputRef.current?.focus()
    }
  }

  // No maxLength on the field: a pasted "419 275" must arrive whole, it is cut to six digits here.
  function change(raw: string) {
    const digits = cleanCode(raw)
    setCode(digits)
    setShort(false)
    if (digits) setHintStale(true)
    if (digits.length === CODE_LENGTH) void send(digits)
  }

  const note = short ? CODE_SHORT : hint && !hintStale ? hint : null
  const cls = ['ps', on ? 'on' : '', code.length === CODE_LENGTH ? 'has' : '', note ? 'bad' : ''].filter(Boolean).join(' ')
  return (
    <form
      className={cls}
      inert={!on}
      aria-hidden={!on || undefined}
      aria-label="Kód z e-mailu"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        void send(code)
      }}
    >
      <p className="ps-note" id="u-code-note" role="status" aria-live="polite">
        {note}
      </p>
      <div className={`line ${nudgeCls}`.trim()}>
        <input
          ref={inputRef}
          className="pf-in code"
          id="u-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="Kód z e-mailu"
          value={code}
          onChange={(e) => change(e.target.value)}
          readOnly={busy}
          aria-label="Šestimístný kód"
          aria-invalid={note ? true : undefined}
          aria-describedby="u-code-note"
        />
        <GoButton busy={busy} label="Přihlásit" />
        <span className="ticks" aria-hidden="true">
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <i key={i} className={i < code.length ? 'on' : undefined} />
          ))}
        </span>
      </div>
      <div className="tools">
        <button type="button" className="ps-back" onClick={onBack} disabled={busy} aria-label={`Jiný e-mail než ${email}`} title="Jiný e-mail">
          <Icon name="arrow-left" size={16} />
          <span aria-hidden="true">{email}</span>
        </button>
      </div>
    </form>
  )
}
