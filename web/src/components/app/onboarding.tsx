import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Icon } from './icon'

const DEFAULT_NAME = 'Dominik'
const OK = 'Got it'
const REDUCE = '(prefers-reduced-motion: reduce)'

/** The intro shows once per account: only for a member the server says has not seen it yet. */
export function needsOnboarding(me: { status: string; onboarded?: boolean } | undefined): boolean {
  return me?.status === 'member' && me.onboarded === false
}

/** The encrypted intro: a nod to PGP. */
export const ENCRYPTED_LINE = 'This offers Pretty Good Privacy, for you, me and our agents.'

export function introLine(name: string, encrypted: boolean): string {
  if (encrypted) return ENCRYPTED_LINE
  const who = name.trim() || DEFAULT_NAME
  return `Goes straight to ${who}'s Mac.`
}

/** Reduced motion is read in JS too, so the scene can drop the flying ping instead of only freezing it. */
function useStill() {
  const [still, setStill] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(REDUCE).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(REDUCE)
    const sync = () => setStill(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return still
}

/** Two icons on top of each other, so the shackle can drop on its own. */
export function Lock({ size }: { size: number }) {
  return (
    <span className="ob-lock" style={{ '--s': `${size}px` } as CSSProperties}>
      <Icon name="lock-body" size={size} />
      <span className="ob-sh">
        <Icon name="lock-shackle" size={size} />
      </span>
    </span>
  )
}

/**
 * The first-time intro: a ping leaves the input line and lands on the island of the recipient's Mac.
 * Opens once on mount; any way of closing it (button, Esc, a click outside) calls onDone exactly once.
 */
export function Onboarding({
  name = DEFAULT_NAME,
  encrypted = false,
  onDone,
  onClosed,
}: {
  /** Who the pings go to (phase 1: always Dominik). */
  name?: string
  /** Phase 2: the copy and the lock say the text is end-to-end encrypted. */
  encrypted?: boolean
  onDone: () => void
  /** After the dialog is gone, for example to put the keyboard in the title field. */
  onClosed?: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const done = useRef(false)
  // A click only counts as "outside" when it also started outside (not a text drag that ended there).
  const downOutside = useRef(false)
  const still = useStill()
  const textId = useId()

  // Opened once. Closing stays local: the server flag may lag, and a re-render must not reopen it.
  useEffect(() => {
    const d = ref.current
    if (!d || d.open) return
    if (typeof d.showModal === 'function') d.showModal()
    else d.setAttribute('open', '')
    okRef.current?.focus()
  }, [])

  const finish = useCallback(() => {
    if (done.current) return
    done.current = true
    onDone()
    onClosed?.()
  }, [onDone, onClosed])

  const close = useCallback(() => {
    const d = ref.current
    if (d?.open) {
      if (typeof d.close === 'function') d.close()
      else d.removeAttribute('open')
    }
    finish()
  }, [finish])

  return (
    <dialog
      ref={ref}
      className="ob"
      aria-labelledby={textId}
      onCancel={(e) => {
        e.preventDefault()
        close()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        close()
      }}
      onClose={finish}
      onPointerDown={(e) => {
        downOutside.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOutside.current) close()
      }}
    >
      <div className="ob-in">
        <div className="ob-scene" data-still={still || undefined} aria-hidden="true">
          <span className="ob-mac" />
          <span className="ob-isl">
            <span className="ob-isl-c">
              <span className="ob-dot" />
              <span className="ob-bar" />
              {encrypted && <Lock size={11} />}
            </span>
          </span>
          <span className="ob-line">
            <span className="ob-txt" />
            <span className="ob-go">
              <Icon name="send" size={15} />
            </span>
            <span className="ob-sweep" />
          </span>
          {!still && (
            <span className="ob-ping">
              <span className="ob-py">
                <span className={encrypted ? 'ob-p lk' : 'ob-p'}>{encrypted && <Lock size={14} />}</span>
              </span>
            </span>
          )}
        </div>
        <p className="ob-t" id={textId}>
          {introLine(name, encrypted)}
        </p>
        <button ref={okRef} type="button" className="ob-ok" onClick={close}>
          {OK}
        </button>
      </div>
    </dialog>
  )
}
