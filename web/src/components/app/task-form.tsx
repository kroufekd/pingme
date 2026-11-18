import { useRef, useState } from 'react'
import type { FormEvent, ReactNode, Ref } from 'react'
import { agentPlaceholder, pingPlaceholder } from '@/lib/people'
import { URGENCIES, urgencyOf } from '@/lib/tasks'
import type { Urgency } from '@/lib/tasks'
import { DAY_MS, MAX_DAYS, dateTime, dayKey, laterDefault, timeKey } from '@/lib/time'
import { charsLeft, checkLater } from '@/lib/validate'
import { Icon } from './icon'
import { TimeField } from './time-field'
import { NO_APP, PeoplePicker } from './people-picker'
import type { Person } from './people-picker'
import { useNudge } from './sign-in'

export const MAX_TITLE = 200

/** `to` is the recipient's userId; `forAgent` sends it to their agent instead. */
export type NewTask = { title: string; urgency: Urgency; dueAt: number; to: string; forAgent: boolean }
export type SendResult = { ok: true } | { ok: false; error: string }

const NOTES: Record<string, string> = {
  'no-time': 'Pick a day and time.',
  'past-time': 'That time has passed.',
  'bad-time': "That time doesn't work.",
  'no-device': `${NO_APP}.`,
  'rate-limited': 'Too many pings. Try again in a moment.',
}
const FAILED = "Didn't send. Try again."
export const NO_APP_FOR = (name: string) => `${name.split(' ')[0]} hasn't set up the Mac app yet, so pings can't reach them.`
const EMPTY = 'Write what you need.'
const AGENT = 'Agent'
const LATER = 'Send later'

/** Who the form sends to when nobody was picked: the first contact that has the app. */
/** A contact with the app first, so adding yourself to the list never changes where pings go. */
function defaultPerson(people: Person[]) {
  return people.find((p) => p.hasMac && !p.self) ?? people.find((p) => p.self) ?? people[0] ?? null
}

export function TaskForm({
  on,
  people,
  onSend,
  panelRef,
  aside,
}: {
  on: boolean
  /** The member's contacts; null while they load. */
  people: Person[] | null
  onSend: (task: NewTask) => Promise<SendResult>
  panelRef: Ref<HTMLFormElement>
  /** Sits at the right end of the row of small controls (the sent-list toggle). */
  aside?: ReactNode
}) {
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  // Both kept after sending: several messages for the same person or agent in a row are common.
  const [picked, setPicked] = useState<string | null>(null)
  const [forAgent, setForAgent] = useState(false)
  const list = people ?? []
  const chosen = list.find((p) => p.userId === picked) ?? defaultPerson(list)
  // Without the app nothing can reach them. While contacts load, sending just waits for them.
  const blocked = people !== null && !chosen?.hasMac
  const [urgency, setUrgency] = useState<Urgency>('green')
  const [later, setLater] = useState(false)
  const [day, setDay] = useState('')
  const [time, setTime] = useState('')
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
    if (blocked || !chosen) {
      nudge()
      if (chosen) setNote(chosen.self ? NOTES['no-device'] : NO_APP_FOR(chosen.name))
      return
    }
    const now = Date.now()
    let dueAt = now
    // The agent gets it now, once.
    if (later && !forAgent) {
      const when = checkLater(day, time, now)
      if (!when.ok) {
        nudgeLater()
        return setNote(NOTES[when.error])
      }
      dueAt = when.at
    }
    const task: NewTask = { title: text, urgency, dueAt, to: chosen.userId, forAgent }
    const before = { title, urgency, later, day, time }

    // The row is in the sent list right away, the form is ready for the next one.
    setNote(null)
    setFlown((n) => n + 1)
    setTitle('')
    setUrgency('green')
    setLater(false)
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
    }
  }

  // Only read the clock once the panel is open, so the server render matches the first client render.
  const today = later ? Date.now() : 0
  const laterOn = later && !forAgent
  // The same check as on send, shown as soon as the picked time is off.
  const when = laterOn ? checkLater(day, time, Date.now()) : null
  const laterBad = when && !when.ok ? NOTES[when.error] : null
  // A contact without the app is said right away, not after a send that cannot work.
  const noApp = blocked && chosen && !chosen.self ? NO_APP_FOR(chosen.name) : null
  const shownNote = note ?? laterBad ?? noApp
  const left = charsLeft(title.length, MAX_TITLE)
  const cls = ['ps', 'pf', urgencyOf(urgency).cls, on ? 'on' : '', title.trim() ? 'has' : '', empty || (note && !laterBad) ? 'bad' : ''].filter(Boolean).join(' ')

  return (
    <form ref={panelRef} className={cls} inert={!on} aria-hidden={!on || undefined} aria-label="New ping" onSubmit={submit} noValidate>
      <p className={left === null ? 'ps-note' : 'ps-note short'} id="u-form-note" role="status" aria-live="polite">
        {shownNote}
        {empty && !shownNote && <span className="vh">{EMPTY}</span>}
      </p>
      <span className={['ps-count', left === null ? '' : 'on', left === 0 ? 'full' : ''].filter(Boolean).join(' ')} id="u-count" aria-hidden={left === null || undefined}>
        <span aria-hidden="true">{left ?? 0}</span>
        <span className="vh">{left === null ? '' : `${left} characters left`}</span>
      </span>
      <label className="vh" htmlFor="u-title">{forAgent ? 'Message for the agent' : 'Ping'}</label>
      <div className={`line ${nudgeCls}`.trim()}>
        <input
          ref={titleRef}
          className="pf-in"
          id="u-title"
          name="title"
          type="text"
          placeholder={forAgent ? agentPlaceholder(chosen?.name, chosen?.self) : pingPlaceholder(chosen?.name, chosen?.self)}
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
        <button type="submit" className="go" aria-label="Send" title={blocked && chosen ? NO_APP : 'Send'} aria-disabled={blocked || undefined}>
          <span key={flown} className={flown ? 'go-i fly' : 'go-i'}>
            <Icon name="send" size={20} />
          </span>
        </button>
        <span key={`sweep-${flown}`} className={flown ? 'sweep run' : 'sweep'} aria-hidden="true" />
      </div>
      <div className="tools">
        {list.length >= 2 && chosen ? (
          <>
            <PeoplePicker
              people={list}
              chosen={chosen}
              onPick={(id) => {
                setPicked(id)
                setNote(null)
              }}
            />
            <button
              type="button"
              className="tool ag"
              aria-pressed={forAgent}
              aria-label={AGENT}
              title={AGENT}
              onClick={() => {
                if (!forAgent) setLater(false)
                setForAgent(!forAgent)
                setNote(null)
              }}
            >
              <Icon name="robot" />
            </button>
          </>
        ) : (
          <fieldset className="tos" data-to={forAgent ? 'agent' : 'person'}>
            <legend className="vh">To</legend>
            <label title={!chosen ? undefined : chosen.hasMac ? chosen.name : NO_APP} className={chosen && !chosen.hasMac ? 'nomac' : undefined}>
              <input
                type="radio"
                name="to"
                value="person"
                aria-label={chosen ? (chosen.hasMac ? chosen.name : `${chosen.name}, ${NO_APP.toLowerCase()}`) : 'Person'}
                checked={!forAgent}
                onChange={() => {
                  setForAgent(false)
                  setNote(null)
                }}
              />
              <span>
                <Icon name="user" />
                {chosen?.hasMac && chosen.online && <i className="on-dot" />}
              </span>
            </label>
            <label title={AGENT}>
              <input
                type="radio"
                name="to"
                value="agent"
                aria-label={AGENT}
                checked={forAgent}
                onChange={() => {
                  setForAgent(true)
                  setLater(false)
                  setNote(null)
                }}
              />
              <span>
                <Icon name="robot" />
              </span>
            </label>
          </fieldset>
        )}
        <fieldset className="urgs">
          <legend className="vh">How urgent</legend>
          {URGENCIES.map((u) => (
            <label key={u.value} className={u.cls} title={u.word}>
              <input type="radio" name="urgency" value={u.value} aria-label={u.word} checked={urgency === u.value} onChange={() => setUrgency(u.value)} />
              <span />
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className={forAgent ? 'tool off' : 'tool'}
          aria-expanded={later}
          aria-controls="u-later"
          aria-label={LATER}
          title={LATER}
          onClick={toggleLater}
          inert={forAgent}
          aria-hidden={forAgent || undefined}
        >
          <Icon name="clock" />
        </button>
        {aside}
      </div>
      <div className={['pf-later', laterOn ? 'on' : '', laterBad ? 'bad' : '', laterNudgeCls].filter(Boolean).join(' ')} id="u-later" inert={!laterOn} aria-hidden={!laterOn || undefined}>
        <input
          className="chip"
          type="date"
          aria-label="Day"
          title="Day"
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
        <TimeField
          value={time}
          min={later && day === dayKey(today) ? timeKey(today) : undefined}
          invalid={!!laterBad}
          describedBy={laterBad ? 'u-form-note' : undefined}
          onChange={(v) => {
            setTime(v)
            setNote(null)
          }}
        />
      </div>
    </form>
  )
}
