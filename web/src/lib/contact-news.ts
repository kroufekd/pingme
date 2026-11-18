// "Michal joined", "Michal can get pings now": this browser remembers who it has seen and with or
// without a Mac, and tells what changed. Nothing about it is stored on the server.

const KEY = 'pingme.contacts-known'

/** userId -> had a Mac when last seen. `first` until the list has been learned once. */
export type Known = { first: boolean; people: Record<string, boolean> }
export type News = { userId: string; name: string; hasMac: boolean; kind: 'joined' | 'mac' }

export function contactNews(contacts: { userId: string; name: string; hasMac: boolean }[], known: Known): News[] {
  if (known.first) return []
  const news: News[] = []
  for (const c of contacts) {
    const before = known.people[c.userId]
    if (before === undefined) news.push({ userId: c.userId, name: c.name, hasMac: c.hasMac, kind: 'joined' })
    else if (!before && c.hasMac) news.push({ userId: c.userId, name: c.name, hasMac: true, kind: 'mac' })
  }
  return news
}

export function loadKnown(): Known {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (raw && typeof raw === 'object' && 'people' in raw) {
      const people: Record<string, boolean> = {}
      for (const [id, mac] of Object.entries((raw as { people: unknown }).people ?? {})) {
        if (typeof mac === 'boolean') people[id] = mac
      }
      return { first: false, people }
    }
  } catch {
    // Unreadable: start over quietly.
  }
  return { first: true, people: {} }
}

export function saveKnown(known: Known) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ people: known.people }))
  } catch {
    // Not remembered; the same news may show again.
  }
}
