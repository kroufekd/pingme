import { useEffect, useLayoutEffect, useRef, useState } from 'react'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const STEP_MINUTES = Array.from({ length: 12 }, (_, i) => i * 5)
const pad = (n: number) => String(n).padStart(2, '0')

function parse(value: string): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})/.exec(value)
  return m ? { h: Number(m[1]), m: Number(m[2]) } : null
}

/** A desktop with a mouse. There the browser's own time list is a grey box, so ours replaces it; phones keep their wheel. */
function useFinePointer() {
  const [fine, setFine] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia?.('(hover: hover) and (pointer: fine)')
    if (!mq) return
    const sync = () => setFine(mq.matches)
    sync()
    mq.addEventListener?.('change', sync)
    return () => mq.removeEventListener?.('change', sync)
  }, [])
  return fine
}

/** Puts the chosen item of a column in its middle. */
function center(col: HTMLElement | null, smooth: boolean) {
  const on = col?.querySelector<HTMLElement>('.on')
  if (!col || !on) return
  const top = on.offsetTop - (col.clientHeight - on.offsetHeight) / 2
  if (smooth && typeof col.scrollTo === 'function') col.scrollTo({ top, behavior: 'smooth' })
  else col.scrollTop = top
}

/**
 * The time chip. The native input stays the field (typing, arrow keys, screen readers, the
 * phone's wheel); on a desktop a click opens two columns, hours and five-minute steps, in the
 * look of the page. Focus never leaves the input, so Escape and Enter close the list and Enter
 * does not send the form while it is open. `min` dims the times already gone today.
 */
export function TimeField({
  value,
  onChange,
  min,
  invalid,
  describedBy,
}: {
  value: string
  onChange: (value: string) => void
  min?: string
  invalid?: boolean
  describedBy?: string
}) {
  const fine = useFinePointer()
  const [open, setOpen] = useState(false)
  const hoursRef = useRef<HTMLDivElement>(null)
  const minutesRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const wrap = useRef<HTMLSpanElement>(null)

  // A press anywhere else closes it (the input may not have focus, e.g. after a click in Safari).
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  const cur = parse(value)
  const low = min ? parse(min) : null
  // A time typed off the five-minute grid still shows as chosen.
  const minutes = cur && !STEP_MINUTES.includes(cur.m) ? [...STEP_MINUTES, cur.m].sort((a, b) => a - b) : STEP_MINUTES

  // Opening jumps to the chosen time; a change while open glides there.
  useLayoutEffect(() => {
    if (!open) {
      wasOpen.current = false
      return
    }
    const smooth = wasOpen.current
    center(hoursRef.current, smooth)
    center(minutesRef.current, smooth)
    wasOpen.current = true
  }, [open, value])

  function pick(h: number | null, m: number | null) {
    const next = `${pad(h ?? cur?.h ?? 0)}:${pad(m ?? cur?.m ?? 0)}`
    if (next !== value) onChange(next)
    // The minute is the last choice: done.
    if (m !== null) setOpen(false)
  }

  const pastHour = (h: number) => !!low && h < low.h
  const pastMinute = (m: number) => !!low && !!cur && (cur.h < low.h || (cur.h === low.h && m < low.m))

  return (
    <span className="tf" ref={wrap}>
      <input
        className="chip"
        type="time"
        aria-label="Time"
        title="Time"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={describedBy}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={() => {
          if (fine) setOpen(true)
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (!open || (e.key !== 'Escape' && e.key !== 'Enter')) return
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
        }}
      />
      {fine && (
        // Only for the mouse: the input itself is the field for the keyboard and screen readers.
        <span className={open ? 'tf-pop on' : 'tf-pop'} aria-hidden="true" inert={!open} onMouseDown={(e) => e.preventDefault()}>
          <span className="tf-col" ref={hoursRef}>
            {HOURS.map((h) => (
              <button
                key={h}
                type="button"
                tabIndex={-1}
                className={[cur?.h === h ? 'on' : '', pastHour(h) ? 'past' : ''].filter(Boolean).join(' ') || undefined}
                onClick={() => pick(h, null)}
              >
                {pad(h)}
              </button>
            ))}
          </span>
          <span className="tf-sep">:</span>
          <span className="tf-col" ref={minutesRef}>
            {minutes.map((m) => (
              <button
                key={m}
                type="button"
                tabIndex={-1}
                className={[cur?.m === m ? 'on' : '', pastMinute(m) ? 'past' : ''].filter(Boolean).join(' ') || undefined}
                onClick={() => pick(null, m)}
              >
                {pad(m)}
              </button>
            ))}
          </span>
        </span>
      )}
    </span>
  )
}
