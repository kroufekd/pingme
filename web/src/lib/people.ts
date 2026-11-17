// Names as the form shows them: initials in a circle and "Pingni Dominika…".

/** "Dominik Kroufek" -> "DK", "Viki" -> "V". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = (w: string) => Array.from(w)[0]?.toUpperCase() ?? ''
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[1])
}

const SOFT = 'žščřcjďťňsxz'

/**
 * The first name in the accusative, or null when the plain rules could be wrong Czech
 * (a mobile e like Marek or Pavel, Jiří, endings we do not know).
 */
export function accusative(name: string): string | null {
  const n = name.trim().split(/\s+/)[0] ?? ''
  if (!/^\p{L}{2,}$/u.test(n)) return null
  const last = n.slice(-1).toLowerCase()
  if (/[eě][kcl]$/i.test(n)) return null
  if (last === 'a') return `${n.slice(0, -1)}u`
  if (/ie$/i.test(n)) return `${n.slice(0, -1)}i`
  if (last === 'i' || last === 'y') return n
  if ('áéíóúůýeěo'.includes(last)) return null
  if (SOFT.includes(last)) return `${n}e`
  return `${n}a`
}

/** The input's placeholder for a person. Nominative when the accusative is not safe. */
export function pingPlaceholder(name: string | null | undefined): string {
  const n = name?.trim()
  if (!n) return 'Pingni…'
  const acc = accusative(n)
  return acc ? `Pingni ${acc}…` : `Co má ${n.split(/\s+/)[0]} udělat…`
}
