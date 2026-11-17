import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './icon'

export const REPO_URL = 'https://github.com/kroufekd/pingme'
export const AGENT_PROMPT = `Install pingme from ${REPO_URL} and connect it to my account.`
const LABEL = 'Connect your agent'
const BRANDS = [
  { name: 'claude', title: 'Claude Code' },
  { name: 'openai', title: 'Codex' },
  { name: 'cursor', title: 'Cursor' },
]

/**
 * A quiet button under the form. It opens one sentence to paste into Claude Code, Codex or
 * Cursor: the agent installs the Mac app and the person confirms the pairing in the browser.
 * It is the last thing on the page, so opening it moves nothing above it. `side` sits in the
 * same row (another quiet toggle), `below` under this panel (that toggle's panel).
 */
export function ConnectAgent({ side, below }: { side?: ReactNode; below?: ReactNode } = {}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const id = useId()
  const textRef = useRef<HTMLParagraphElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  async function copy() {
    let ok = false
    try {
      await navigator.clipboard.writeText(AGENT_PROMPT)
      ok = true
    } catch {
      // No clipboard (http, old browser, denied): select the sentence for a manual copy.
      const el = textRef.current
      const sel = window.getSelection?.()
      if (el && sel) {
        const range = document.createRange()
        range.selectNodeContents(el)
        sel.removeAllRanges()
        sel.addRange(range)
      }
    }
    setCopied(ok)
    if (timer.current) clearTimeout(timer.current)
    if (ok) timer.current = setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="cn">
      <div className="cn-bar">
        <button ref={buttonRef} type="button" className="cn-b" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <span className="cn-faces" aria-hidden="true">
            {BRANDS.map((b) => (
              <span key={b.name} title={b.title}>
                <Icon name={`brands/${b.name}`} size={14} />
              </span>
            ))}
          </span>
          <span>{LABEL}</span>
        </button>
        {side}
      </div>
      <div
        className={open ? 'cn-p on' : 'cn-p'}
        id={id}
        inert={!open}
        aria-hidden={!open || undefined}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          setOpen(false)
          buttonRef.current?.focus()
        }}
      >
        <p className="cn-q" ref={textRef}>
          {AGENT_PROMPT}
        </p>
        <div className="cn-row">
          <button type="button" className={copied ? 'chip cn-c ok' : 'chip cn-c'} onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy'} title={copied ? 'Copied' : 'Copy'}>
            <Icon name={copied ? 'check' : 'copy'} size={16} />
          </button>
          <a className="chip cn-l" href={REPO_URL} target="_blank" rel="noreferrer">
            <span>github.com/kroufekd/pingme</span>
            <Icon name="arrow-right" size={14} />
          </a>
        </div>
        <span className="vh" role="status" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </div>
      {below}
    </div>
  )
}
