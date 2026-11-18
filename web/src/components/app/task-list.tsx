import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { initials } from '@/lib/people'
import { ICONS, KINDS, kindOf, spokenFor, urgencyOf, wordFor } from '@/lib/tasks'
import type { Kind, Row } from '@/lib/tasks'
import { useNow } from '@/lib/time'
import { Icon } from './icon'

export const SENT_ID = 'u-sent'
export const TITLE_ELSEWHERE = 'Text is on another device.'
export const REPLY_ELSEWHERE = 'Reply is on another device.'

/** A reply this device has to show: its text, or the note that it was sealed for another device. */
function hasReply(r: Row) {
  return !!r.reply || !!r.replyMissing
}

/** True while a reply waits that the sender has not had on screen yet. */
export function hasUnseenReply(rows: Row[]) {
  return rows.some((r) => r.replyPending && hasReply(r))
}

/**
 * The small icon that opens the sent list: a count, and a badge while a reply waits unread.
 * It only fades in once there is something to show, its place in the row is always kept.
 */
export function SentToggle({ count, badge, open, onToggle }: { count: number; badge: boolean; open: boolean; onToggle: () => void }) {
  const shown = count > 0
  const label = `Sent: ${count}${badge ? ', new reply' : ''}`
  return (
    <button
      type="button"
      className={['sent', shown ? '' : 'off', open ? 'open' : ''].filter(Boolean).join(' ')}
      aria-expanded={open}
      aria-controls={SENT_ID}
      aria-label={label}
      title={badge ? 'Sent, new reply' : 'Sent'}
      onClick={onToggle}
      inert={!shown}
      aria-hidden={!shown || undefined}
    >
      <span className="sent-i">
        <Icon name="sent" />
        {badge && <i className="badge" data-testid="reply-badge" />}
      </span>
      <span key={count} className="sent-n" aria-hidden="true">
        {count}
      </span>
    </button>
  )
}

/** Icon only. The word is in the tooltip and, spoken in full, for screen readers. */
export const NOT_DELIVERED = 'Not delivered: their Mac stayed off for a week after it was due.'

function StatusCell({ row, kind, now }: { row: Row; kind: Kind; now: number }) {
  return (
    <span className="st" title={wordFor(kind, row, now)}>
      {KINDS.map((k) => {
        const on = k === kind
        const cls = [on ? 'on' : '', k === 'done' ? 'ok' : '', k === 'lost' ? 'bad' : ''].filter(Boolean).join(' ')
        return (
          <span key={k} className={cls || undefined} aria-hidden={!on || undefined}>
            {k === 'typing' ? (
              <i className="dots3">
                <i />
                <i />
                <i />
              </i>
            ) : (
              <Icon name={ICONS[k]} />
            )}
            {on && <span className="vh">{spokenFor(k, row, now)}</span>}
          </span>
        )
      })}
    </span>
  )
}

function Item({ row, reply, now, isNew, index, showWho }: { row: Row; reply: string | undefined; now: number; isNew: boolean; index: number; showWho: boolean }) {
  const u = urgencyOf(row.urgency)
  const kind = kindOf(row, now)
  const cls = ['it', u.cls, kind === 'done' ? 'gone' : '', isNew ? 'new' : ''].filter(Boolean).join(' ')
  return (
    <li className={cls} style={{ '--n': Math.min(index, 8) } as CSSProperties}>
      <span className="dot" aria-hidden="true" />
      <span className="vh">{u.word}: </span>
      <div className="it-b">
        {row.title !== null || row.titleMissing ? (
          <p className={row.title === null ? 'it-t it-miss' : 'it-t'}>
            {showWho && row.toName && (
              <span className="it-who" title={row.toName}>
                <span aria-hidden="true">{initials(row.toName)}</span>
                <span className="vh">{row.toName}: </span>
              </span>
            )}
            {row.to === 'agent' && (
              <span className="it-to" title="Agent">
                <Icon name="robot" size={14} />
                <span className="vh">Agent</span>
              </span>
            )}
            {row.title ?? TITLE_ELSEWHERE}
          </p>
        ) : (
          <p className="it-t">
            <span className="it-ph" aria-hidden="true" />
            <span className="vh">Loading text</span>
          </p>
        )}
        {kind === 'lost' && <p className="it-lost">{NOT_DELIVERED}</p>}
        {(reply || row.replyMissing) && (
          <p className={reply ? 'it-r' : 'it-r it-miss'}>
            <Icon name="reply" size={14} />
            <span className="vh">Reply: </span>
            <span>{reply ?? REPLY_ELSEWHERE}</span>
          </p>
        )}
      </div>
      <StatusCell row={row} kind={kind} now={now} />
    </li>
  )
}

/**
 * What you sent, newest first, with a live status. Closed by default: the rows only exist while
 * `open`, the rest (kept replies, announcements) lives on so nothing is lost between openings.
 * `keyOf` keeps a row's DOM node when the optimistic row is replaced by the real one, so its
 * status animates instead of remounting.
 */
export function SentList({
  rows,
  keyOf,
  onAck,
  open,
  showWho = false,
}: {
  rows: Row[]
  keyOf: (row: Row) => string
  onAck: (taskRef: string) => Promise<unknown>
  open: boolean
  /** More than one contact: each row says who it went to. */
  showWho?: boolean
}) {
  const live = open && rows.some((r) => r.status === 'snoozed' || (r.typingUntil !== undefined && r.typingUntil > Date.now() - 1000))
  const now = useNow(live ? 1000 : 30_000)

  // Rows that were there when the list opened rise in together; only later arrivals drop in.
  const known = useRef<Set<string> | null>(null)
  if (known.current === null || !open) known.current = new Set(rows.map(keyOf))

  // A reply stays on its row after the server forgets it (it is deleted once acked).
  const replies = useRef(new Map<string, string>())
  for (const r of rows) if (r.reply) replies.current.set(r.taskRef, r.reply)

  // Ack each pending reply once, and only when the sender can really see it:
  // the list is open and the page is visible.
  const acked = useRef(new Set<string>())
  useEffect(() => {
    if (!open) return
    const pending = rows.filter((r) => r.replyPending && hasReply(r))
    if (pending.length === 0) return
    const run = () => {
      if (document.visibilityState === 'hidden') return
      for (const r of pending) {
        const id = `${r.taskRef}:${r.replyAt ?? ''}`
        if (acked.current.has(id)) continue
        acked.current.add(id)
        onAck(r.taskRef).catch(() => acked.current.delete(id))
      }
    }
    run()
    document.addEventListener('visibilitychange', run)
    return () => document.removeEventListener('visibilitychange', run)
  }, [rows, onAck, open])

  // One quiet announcement per status change, never for the ticking time.
  const kinds = useRef<Map<string, Kind> | null>(null)
  const [said, setSaid] = useState('')
  useEffect(() => {
    const next = new Map<string, Kind>()
    const changes: string[] = []
    for (const r of rows) {
      const key = keyOf(r)
      const kind = kindOf(r, now)
      next.set(key, kind)
      if (kinds.current && kinds.current.get(key) !== kind) changes.push(`${r.title ?? 'Ping'}: ${spokenFor(kind, r, now)}`)
    }
    kinds.current = next
    if (changes.length > 0) setSaid(changes.join('. '))
  }, [rows, now, keyOf])

  return (
    <section className="its-wrap" id={SENT_ID} aria-label="Sent">
      {open && (
        <ul className="its">
          {rows.map((r, i) => {
            const key = keyOf(r)
            return <Item key={key} row={r} reply={r.reply ?? replies.current.get(r.taskRef)} now={now} isNew={!known.current?.has(key)} index={i} showWho={showWho} />
          })}
        </ul>
      )}
      <p className="vh" role="status" aria-live="polite">
        {said}
      </p>
    </section>
  )
}
