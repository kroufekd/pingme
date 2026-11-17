import type { CSSProperties } from 'react'

/** A stroke icon from public/icons, drawn as a mask so it takes the text colour. */
export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return <span className="ico" aria-hidden="true" style={{ '--i': `url(/icons/${name}.svg)`, '--s': `${size}px` } as CSSProperties} />
}
