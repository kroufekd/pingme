import { useEffect, useRef, useState } from 'react'
import type { Row } from '@/lib/tasks'
import { Icon } from './icon'

export const REPLIED = (name?: string) => (name ? `${name} replied` : 'New reply')
export const NOTIFY_ASK = 'Get a notification here when someone replies?'
export const NOTIFY_ON = 'Turn on'
const NOT_NOW = 'Not now'
const ASKED_KEY = 'pingme.notify-asked'

/** A reply this browser has not had on screen yet: its text, or the note that it is elsewhere. */
function unseen(r: Row) {
  return r.replyPending && (!!r.reply || !!r.replyMissing)
}

function permission(): NotificationPermission | null {
  return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : null
}

/**
 * Unread replies count in the tab title, and a system notification for a new one while the tab is
 * hidden (only when the person turned them on). Everything is worked out here from the sent list:
 * the server keeps no read state. The first list is only learned, so old replies never notify.
 */
export function useReplyAlerts(rows: Row[], ready: boolean) {
  const count = ready ? rows.filter(unseen).length : 0
  const base = useRef<string | null>(null)
  useEffect(() => {
    if (base.current === null) base.current = document.title.replace(/^\(\d+\) /, '')
    document.title = count ? `(${count}) ${base.current}`.trim() : base.current
  }, [count])
  useEffect(
    () => () => {
      if (base.current !== null) document.title = base.current
    },
    [],
  )

  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!ready) return
    const ids = rows.filter((r) => r.replyAt !== undefined).map((r) => [`${r.taskRef}:${r.replyAt}`, r] as const)
    if (known.current === null) {
      known.current = new Set(ids.map(([id]) => id))
      return
    }
    for (const [id, r] of ids) {
      if (known.current.has(id)) continue
      // Wait for the text to open; the id is only learned once it is shown.
      if (!r.reply && !r.replyMissing) continue
      known.current.add(id)
      if (document.visibilityState !== 'hidden' || permission() !== 'granted') continue
      try {
        const n = new Notification(REPLIED(r.toName), { body: r.reply ?? '', tag: id })
        n.onclick = () => {
          window.focus()
          n.close()
        }
      } catch {
        // Some browsers only allow notifications from a service worker: the title count still says it.
      }
    }
  }, [rows, ready])
}

/** Asks once, from a click, whether replies may notify. Shown after the first ping went out. */
export function NotifyOffer({ show }: { show: boolean }) {
  const [state, setState] = useState<'unknown' | 'ask' | 'done'>('unknown')
  useEffect(() => {
    let asked = false
    try {
      asked = localStorage.getItem(ASKED_KEY) !== null
    } catch {
      // No storage: ask, the answer is kept by the browser anyway.
    }
    setState(permission() === 'default' && !asked ? 'ask' : 'done')
  }, [])
  if (!show || state !== 'ask') return null

  function settle() {
    try {
      localStorage.setItem(ASKED_KEY, String(Date.now()))
    } catch {
      // Not remembered: it may ask again next visit.
    }
    setState('done')
  }

  return (
    <div className="dv-new" role="group" aria-label={NOTIFY_ASK}>
      <span className="dv-new-i">
        <Icon name="bell" size={18} />
      </span>
      <p className="dv-new-t">{NOTIFY_ASK}</p>
      <span className="dv-new-a">
        <button type="button" className="chip" onClick={settle}>
          {NOT_NOW}
        </button>
        <button
          type="button"
          className="chip dv-go"
          onClick={() => {
            settle()
            void Notification.requestPermission().catch(() => {})
          }}
        >
          {NOTIFY_ON}
        </button>
      </span>
    </div>
  )
}
