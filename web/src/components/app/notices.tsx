import { useEffect, useState } from 'react'
import { contactNews, loadKnown, saveKnown } from '@/lib/contact-news'
import type { Known } from '@/lib/contact-news'
import type { Contact } from '@/lib/network'
import { Icon } from './icon'

export const JOINED = (name: string) => `${name} joined pingme.`
export const CAN_GET = (name: string) => `${name} can get pings now.`
export const NO_MAC = "Pings can't reach you yet."
export const NO_MAC_WHY = 'They land on a Mac with the pingme app.'
export const SET_UP = 'Set up the Mac'
const OK = 'OK'
const LATER = 'Later'
const LATER_KEY = 'pingme.no-mac-later'
const LATER_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Someone you invited joined, or a contact connected a Mac: said once, in this browser.
 * Worked out here from the contact list the page already has; the server keeps no "seen" state.
 */
export function ContactNews({ contacts }: { contacts: Contact[] }) {
  // Read after mount: the server render has no storage.
  const [known, setKnown] = useState<Known | null>(null)
  useEffect(() => setKnown(loadKnown()), [])
  // The first visit only learns the list: nothing is news yet.
  useEffect(() => {
    if (known && known.first) {
      const next = { first: false, people: Object.fromEntries(contacts.map((c) => [c.userId, c.hasMac])) }
      saveKnown(next)
      setKnown(next)
    }
  }, [known, contacts])
  if (!known || known.first) return null
  const news = contactNews(contacts, known)[0]
  if (!news) return null

  function settle() {
    if (!known || !news) return
    const next = { first: false, people: { ...known.people, [news.userId]: news.hasMac } }
    saveKnown(next)
    setKnown(next)
  }

  const text = news.kind === 'joined' ? JOINED(news.name) : CAN_GET(news.name)
  return (
    <div className="dv-new" role="status">
      <span className="dv-new-i">
        <Icon name={news.kind === 'joined' ? 'user' : 'laptop'} size={18} />
      </span>
      <p className="dv-new-t">{text}</p>
      <span className="dv-new-a">
        <button type="button" className="chip" onClick={settle}>
          {OK}
        </button>
      </span>
    </div>
  )
}

function laterUntil(): number {
  try {
    return Number(localStorage.getItem(LATER_KEY) ?? 0) || 0
  } catch {
    return 0
  }
}

/** The account has no Mac: nothing anyone sends can arrive. Says so, with the way to fix it. */
export function NoMacNotice({ onSetUp }: { onSetUp: () => void }) {
  const [until, setUntil] = useState<number | null>(null)
  useEffect(() => setUntil(laterUntil()), [])
  if (until === null || until > Date.now()) return null

  function later() {
    const at = Date.now() + LATER_MS
    try {
      localStorage.setItem(LATER_KEY, String(at))
    } catch {
      // Not remembered: it asks again next time.
    }
    setUntil(at)
  }

  return (
    <div className="dv-new" role="status">
      <span className="dv-new-i">
        <Icon name="laptop" size={18} />
      </span>
      <p className="dv-new-t">
        <b>{NO_MAC}</b> {NO_MAC_WHY}
      </p>
      <span className="dv-new-a">
        <button type="button" className="chip" onClick={later}>
          {LATER}
        </button>
        <button type="button" className="chip dv-go" onClick={onSetUp}>
          {SET_UP}
        </button>
      </span>
    </div>
  )
}
