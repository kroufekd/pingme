import { useRef, useState } from 'react'
import type { FormEvent, ReactNode, Ref } from 'react'
import { REPEAT_OPTIONS, URGENCIES, urgencyOf } from '@/lib/tasks'
import type { Recipient, Urgency } from '@/lib/tasks'
import { DAY_MS, MAX_DAYS, dateTime, dayKey, laterDefault, timeKey } from '@/lib/time'
import { charsLeft, checkLater } from '@/lib/validate'
import type { Repeat } from '@/lib/time'
import { Icon } from './icon'
import { useNudge } from './sign-in'

export const MAX_TITLE = 200

export type NewTask = { title: string; urgency: Urgency; dueAt: number; repeat?: Repeat; to: Recipient }
export type SendResult = { ok: true } | { ok: false; error: string }

const NOTES: Record<string, string> = {
  'no-time': 'Vyber den a čas.',
  'past-time': 'Tenhle čas už byl.',
  'bad-time': 'Tenhle čas nejde.',
}
const FAILED = 'Neodešlo. Zkus to znovu.'
const EMPTY = 'Napiš, co je potřeba.'
const RECIPIENTS: { value: Recipient; word: string; icon: string }[] = [
  { value: 'dominik', word: 'Dominik', icon: 'user' },
  { value: 'agent', word: 'Agent', icon: 'robot' },
]
const LATER = 'Poslat později'

export function TaskForm({
  on,
  onSend,
  panelRef,
  aside,
}: {
  on: boolean
  onSend: (task: NewTask) => Promise<SendResult>
  panelRef: Ref<HTMLFormElement>
  /** Sits at the right end of the row of small controls (the sent-list toggle). */
  aside?: ReactNode
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  // Kept after sending: several messages for the agent in a row are common.
  const [to, setTo] = useState<Recipient>('dominik')
  const [urgency, setUrgency] = useState<Urgency>('green')
  const [later, setLater] = useState(false)
  const [day, setDay] = useState('')
  const [time, setTime] = useState('')
  const [repeat, setRepeat] = useState<Repeat | ''>('')
  const [note, setNote] = useState<string | null>(null)
  // Counts sends, only to replay the send animation.
  const [flown, setFlown] = useState(0)
  // Send with nothing written: the line shakes and stays marked until the next keystroke. No text on screen.
  const [empty, setEmpty] = useState(false)
  const { cls: nudgeCls, nudge } = useNudge()
  const { cls: laterNudgeCls, nudge: nudgeLater } = useNudge()

  function toggleLater() {
    const picked = dateTime(day, time)
    if (!later && (picked === null || picked < Date.now())) {
      const at = laterDefault(Date.now())
      setDay(dayKey(at))
      setTime(timeKey(at))
    }
    setLater(!later)
    setNote(null)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const text = title.trim()
    if (!text) {
      setEmpty(true)
      nudge()
      titleRef.current?.focus()
      return
    }
    const now = Date.now()
    let dueAt = now
    // The agent gets it now, once.
    if (later && to === 'dominik') {
      const when = checkLater(day, time, now)
      if (!when.ok) {
        nudgeLater()
        return setNote(NOTES[when.error])
      }
      dueAt = when.at
    }
    const task: NewTask = { title: text, urgency, dueAt, repeat: later && repeat && to === 'dominik' ? repeat : undefined, to }
    const before = { title, urgency, later, day, time, repeat }

    // The row is in the sent list right away, the form is ready for the next one.
    setNote(null)
    setFlown((n) => n + 1)
    setTitle('')
    setUrgency('green')
    setLater(false)
    setRepeat('')
    titleRef.current?.focus()

    const res = await onSend(task)
    if (res.ok) return
    setNote(NOTES[res.error] ?? FAILED)
    // Put it back, unless a new task is already being typed.
    if (titleRef.current && titleRef.current.value === '') {
      setTitle(before.title)
      setUrgency(before.urgency)
      setLater(before.later)
      setDay(before.day)
      setTime(before.time)
      setRepeat(before.repeat)
    }
  }

  // Only read the clock once the panel is open, so the server render matches the first client render.
  const today = later ? Date.now() : 0
  const laterOn = later && to === 'dominik'
  // The same check as on send, shown as soon as the picked time is off.
  const when = laterOn ? checkLater(day, time, Date.now()) : null
  const laterBad = when && !when.ok ? NOTES[when.error] : null
  const shownNote = note ?? laterBad
  const left = charsLeft(title.length, MAX_TITLE)
  const repeatWord = repeat ? REPEAT_OPTIONS.find((r) => r.value === repeat)?.label : undefined
  const cls = ['ps', 'pf', urgencyOf(urgency).cls, on ? 'on' : '', title.trim() ? 'has' : '', empty || (note && !laterBad) ? 'bad' : ''].filter(Boolean).join(' ')

  return (
    <form ref={panelRef} className={cls} inert={!on} aria-hidden={!on || undefined} aria-label="Nový úkol" onSubmit={submit} noValidate>
      <p className={left === null ? 'ps-note' : 'ps-note short'} id="u-form-note" role="status" aria-live="polite">
        {shownNote}
        {empty && !shownNote && <span className="vh">{EMPTY}</span>}
      </p>
      <span className={['ps-count', left === null ? '' : 'on', left === 0 ? 'full' : ''].filter(Boolean).join(' ')} id="u-count" aria-hidden={left === null || undefined}>
        <span aria-hidden="true">{left ?? 0}</span>
        <span className="vh">{left === null ? '' : `Zbývá znaků: ${left}`}</span>
      </span>
      <label className="vh" htmlFor="u-title">{to === 'agent' ? 'Zpráva pro agenta' : 'Úkol'}</label>
      <div className={`line ${nudgeCls}`.trim()}>
        <input
          ref={titleRef}
          className="pf-in"
          id="u-title"
          name="title"
          type="text"
          placeholder={to === 'agent' ? 'Zadej práci agentovi…' : 'Pingni Dominika…'}
          autoComplete="off"
          enterKeyHint="send"
          maxLength={MAX_TITLE}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            if (note) setNote(null)
            if (empty) setEmpty(false)
          }}
          aria-invalid={empty || undefined}
          aria-describedby={left === null ? 'u-form-note' : 'u-form-note u-count'}
        />
        <button type="submit" className="go" aria-label="Poslat" title="Poslat">
          <span key={flown} className={flown ? 'go-i fly' : 'go-i'}>
            <Icon name="send" size={20} />
          </span>
        </button>
        <span key={`sweep-${flown}`} className={flown ? 'sweep run' : 'sweep'} aria-hidden="true" />
      </div>
      <div className="tools">
        <fieldset className="tos" data-to={to}>
          <legend className="vh">Pro koho</legend>
          {RECIPIENTS.map((r) => (
            <label key={r.value} title={r.word}>
              <input
                type="radio"
                name="to"
                value={r.value}
                aria-label={r.word}
                checked={to === r.value}
                onChange={() => {
                  setTo(r.value)
                  if (r.value === 'agent') setLater(false)
                  setNote(null)
                }}
              />
              <span>
                <Icon name={r.icon} />
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="urgs">
          <legend className="vh">Jak moc to spěchá</legend>
          {URGENCIES.map((u) => (
            <label key={u.value} className={u.cls} title={u.word}>
              <input type="radio" name="urgency" value={u.value} aria-label={u.word} checked={urgency === u.value} onChange={() => setUrgency(u.value)} />
              <span />
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className={to === 'agent' ? 'tool off' : 'tool'}
          aria-expanded={later}
          aria-controls="u-later"
          aria-label={LATER}
          title={LATER}
          onClick={toggleLater}
          inert={to === 'agent'}
          aria-hidden={to === 'agent' || undefined}
        >
          <Icon name="clock" />
        </button>
        {aside}
      </div>
      <div className={['pf-later', laterOn ? 'on' : '', laterBad ? 'bad' : '', laterNudgeCls].filter(Boolean).join(' ')} id="u-later" inert={!laterOn} aria-hidden={!laterOn || undefined}>
        <input
          className="chip"
          type="date"
          aria-label="Den"
          title="Den"
          aria-invalid={laterBad ? true : undefined}
          aria-describedby={laterBad ? 'u-form-note' : undefined}
          min={later ? dayKey(today) : undefined}
          max={later ? dayKey(today + MAX_DAYS * DAY_MS) : undefined}
          value={day}
          onChange={(e) => {
            setDay(e.target.value)
            setNote(null)
          }}
        />
        <input
          className="chip"
          type="time"
          aria-label="Čas"
          title="Čas"
          aria-invalid={laterBad ? true : undefined}
          aria-describedby={laterBad ? 'u-form-note' : undefined}
          value={time}
          onChange={(e) => {
            setTime(e.target.value)
            setNote(null)
          }}
        />
        <label className={repeat ? 'chip rep set' : 'chip rep'} title="Opakování">
          <Icon name="repeat" size={16} />
          {repeatWord && <span aria-hidden="true">{repeatWord}</span>}
          <select aria-label="Opakování" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat | '')}>
            {REPEAT_OPTIONS.map((r) => (
              <option key={r.value || 'once'} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </form>
  )
}
