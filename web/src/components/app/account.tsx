import { useMutation } from 'convex/react'
import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

export const SIGNED_IN_AS = 'Signed in as'
export const RENAME = 'Rename'
export const SAVE = 'Save'
export const SIGN_OUT = 'Sign out'
export const SIGN_OUT_SURE = 'Sign out and forget this browser'
export const NAME_LABEL = 'Your name'
const CANCEL = 'Cancel'
const NAME_BAD = 'Type a name.'
const ARM_MS = 4000

/**
 * Who is signed in, the name contacts see, and the way out. Signing out asks once more, because it
 * also forgets this browser's key: pings sealed to it cannot be opened here again.
 */
export function Account({ name, email, onSignOut }: { name: string; email?: string; onSignOut: () => Promise<void> }) {
  const rename = useMutation(api.senders.rename)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState(false)
  const fieldRef = useRef<HTMLInputElement>(null)
  const editRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (editing) fieldRef.current?.select()
  }, [editing])
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])

  async function save() {
    const next = draft.trim()
    if (!next) return setNote(NAME_BAD)
    if (next === name) return close()
    setBusy(true)
    try {
      if (await rename({ name: next })) close()
      else setNote(NAME_BAD)
    } catch {
      setNote("That didn't work. Try again.")
    } finally {
      setBusy(false)
    }
  }

  function close() {
    setEditing(false)
    setNote(null)
    editRef.current?.focus()
  }

  async function signOut() {
    if (!armed) return setArmed(true)
    setBusy(true)
    try {
      await onSignOut()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ac">
      {editing ? (
        <form
          className="ac-edit"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.stopPropagation()
            setDraft(name)
            close()
          }}
        >
          <input
            ref={fieldRef}
            className="chip ac-in"
            aria-label={NAME_LABEL}
            aria-invalid={note ? true : undefined}
            aria-describedby="u-ac-note"
            maxLength={60}
            autoComplete="name"
            value={draft}
            readOnly={busy}
            onChange={(e) => {
              setDraft(e.target.value)
              setNote(null)
            }}
          />
          <button type="submit" className="chip dv-go" disabled={busy}>
            {SAVE}
          </button>
          <button
            type="button"
            className="chip"
            onClick={() => {
              setDraft(name)
              close()
            }}
          >
            {CANCEL}
          </button>
        </form>
      ) : (
        <p className="ac-who">
          {SIGNED_IN_AS} <b>{name}</b>
          {email && <span className="ac-mail">{email}</span>}
        </p>
      )}
      <p className="ac-note" id="u-ac-note" role="status" aria-live="polite">
        {note}
      </p>
      {!editing && (
        <span className="ac-act">
          <button
            ref={editRef}
            type="button"
            className="chip"
            onClick={() => {
              setDraft(name)
              setEditing(true)
            }}
          >
            {RENAME}
          </button>
          <button type="button" className={armed ? 'chip dv-rm on' : 'chip'} disabled={busy} onClick={() => void signOut()}>
            {armed ? SIGN_OUT_SURE : SIGN_OUT}
          </button>
        </span>
      )}
    </div>
  )
}
