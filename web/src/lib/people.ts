// Names as the form shows them: initials in a circle and "Ping Dominik…".

/** "Dominik Kroufek" -> "DK", "Viki" -> "V". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = (w: string) => Array.from(w)[0]?.toUpperCase() ?? ''
  return words.length === 1 ? first(words[0]) : first(words[0]) + first(words[1])
}

/** The input's placeholder for a person: "Ping Dominik…". */
export function pingPlaceholder(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0]
  return first ? `Ping ${first}…` : 'Ping…'
}
