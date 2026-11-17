import { useEffect, useId, useRef, useState } from 'react'
import { initials } from '@/lib/people'
import { Icon } from './icon'

/** A contact as the form needs it. `online` is derived from macLastSeen on the page's own timer. */
export type Person = { userId: string; name: string; hasMac: boolean; online: boolean; self?: boolean }

/** You, in the list of people: a ping to yourself lands on your own Mac. */
export const ME = 'Me'

export const NO_APP = 'No app yet'

/** A small circle with the initials, grey without the app, a green dot while the Mac runs. */
export function Face({ person }: { person: Person }) {
  return (
    <span className={person.hasMac ? 'face' : 'face nomac'} aria-hidden="true">
      <span>{person.self ? ME : initials(person.name)}</span>
      {person.hasMac && person.online && <i className="on-dot" />}
    </span>
  )
}

/** Two or more contacts: the chosen one sits in the row of icons, a tap shows everyone. */
export function PeoplePicker({ people, chosen, onPick }: { people: Person[]; chosen: Person; onPick: (userId: string) => void }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const wrap = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  // A press outside closes it.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])

  // Opening puts the keyboard on the chosen person, so arrows move through the list.
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLInputElement>('.who-pop input:checked')?.focus()
  }, [open])

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  const word = chosen.hasMac ? chosen.name : `${chosen.name}, ${NO_APP.toLowerCase()}`
  return (
    <div className="who" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="who-b"
        aria-expanded={open}
        aria-controls={id}
        aria-label={`To: ${word}`}
        title={chosen.hasMac ? chosen.name : NO_APP}
        onClick={() => setOpen((o) => !o)}
      >
        <Face person={chosen} />
      </button>
      <fieldset
        className={open ? 'who-pop on' : 'who-pop'}
        id={id}
        inert={!open}
        aria-hidden={!open || undefined}
        onKeyDown={(e) => {
          // Enter would submit the form; here it only confirms the choice.
          if (e.key === 'Escape' || e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            close()
          }
        }}
      >
        <legend className="vh">To</legend>
        {people.map((p) => (
          <label key={p.userId} title={p.hasMac ? p.name : NO_APP}>
            <input
              type="radio"
              name="who"
              value={p.userId}
              checked={p.userId === chosen.userId}
              aria-label={p.hasMac ? p.name : `${p.name}, ${NO_APP.toLowerCase()}`}
              onChange={() => onPick(p.userId)}
              // A real click picks and closes; arrow keys only move the choice.
              onClick={(e) => {
                if (e.detail > 0) close()
              }}
            />
            <Face person={p} />
            <span className="who-n">
              <span>{p.name}</span>
              {!p.hasMac && <small>{NO_APP}</small>}
            </span>
            {p.userId === chosen.userId && <Icon name="check" size={16} />}
          </label>
        ))}
      </fieldset>
    </div>
  )
}
