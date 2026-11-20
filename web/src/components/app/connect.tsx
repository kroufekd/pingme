import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from './icon'
import { Lock } from './onboarding'

export const REPO_URL = 'https://github.com/kroufekd/pingme'
export const AGENT_PROMPT = `Install pingme from ${REPO_URL} and connect it to my account.`
const LABEL = 'Connect your agent'
export const COPY = 'Copy prompt'
export const COPIED = 'Copied'
const HINT = 'Paste this into Claude Code, Codex or Cursor.'
export const MANUAL_CMD = `git clone ${REPO_URL}.git && ./pingme/mac/install.sh`
const MANUAL = 'No agent? Paste this into Terminal instead (it needs the Xcode Command Line Tools):'
// On a phone the address wraps after a slash, not in the middle of a word.
const PROMPT_PARTS = AGENT_PROMPT.split(/(?<=\.com\/|kroufekd\/)/)
const BRANDS = [
  { name: 'claude', title: 'Claude Code' },
  { name: 'openai', title: 'Codex' },
  { name: 'cursor', title: 'Cursor' },
]

/** Stagger slot for the parts of a panel that slide in one after another. */
export const slot = (i: number) => ({ '--i': i }) as CSSProperties

/**
 * A quiet button under the form. It opens one sentence to paste into Claude Code, Codex or
 * Cursor: the agent installs the Mac app and the person confirms the pairing in the browser.
 * It is the last thing on the page, so opening it moves nothing above it. `side` sits in the
 * same row (the Devices toggle), `below` under this panel (its panel); only one is open at a time.
 */
export function ConnectAgent({ open, onOpenChange, side, below }: { open: boolean; onOpenChange: (open: boolean) => void; side?: ReactNode; below?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  // Bumped on every copy, so the sweep plays again on a second click.
  const [shot, setShot] = useState(0)
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
    if (ok) setShot((n) => n + 1)
    if (timer.current) clearTimeout(timer.current)
    if (ok) timer.current = setTimeout(() => setCopied(false), 1800)
  }

  return (
    <div className="cn">
      <div className="cn-bar">
        <button ref={buttonRef} type="button" className="cn-b" aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)}>
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
        className={open ? 'rv cn-p on' : 'rv cn-p'}
        id={id}
        inert={!open}
        aria-hidden={!open || undefined}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          onOpenChange(false)
          buttonRef.current?.focus()
        }}
      >
        <div className="rv-c">
          <div className="rv-card cn-card">
            <p className="cn-h rv-i" style={slot(0)}>
              {HINT}
            </p>
            {/* The whole card copies; the button is the way in for the keyboard (its click bubbles here). */}
            <div className={copied ? 'cn-cmd rv-i ok' : 'cn-cmd rv-i'} style={slot(1)} onClick={() => void copy()}>
              <span className="cn-pr" aria-hidden="true">
                &gt;
              </span>
              <p className="cn-q" ref={textRef}>
                {PROMPT_PARTS.map((part, i) => (
                  <Fragment key={i}>
                    {i > 0 && <wbr />}
                    {part}
                  </Fragment>
                ))}
                <span className="cn-caret" aria-hidden="true" />
              </p>
              <button type="button" className="cn-c" aria-label={copied ? COPIED : COPY}>
                <span className={copied ? 'cn-c-l' : 'cn-c-l on'} aria-hidden="true">
                  <Icon name="copy" size={15} />
                  {COPY}
                </span>
                <span className={copied ? 'cn-c-l on' : 'cn-c-l'} aria-hidden="true">
                  <Icon name="check" size={15} />
                  {COPIED}
                </span>
                {shot > 0 && <span key={shot} className="cn-ring" aria-hidden="true" />}
              </button>
              {shot > 0 && <span key={shot} className="cn-sweep" aria-hidden="true" />}
            </div>
            <p className="cn-alt rv-i" style={slot(2)}>
              {MANUAL} <code className="cn-alt-c">{MANUAL_CMD}</code>
            </p>
            <ul className="cn-safe">
              <li className="rv-i" style={slot(3)}>
                <span className="cn-safe-i">
                  <Lock size={15} />
                </span>
                <span>
                  <b>End-to-end encrypted.</b> Pings are sealed on your devices, so the server can't read them.
                </span>
              </li>
              <li className="rv-i" style={slot(4)}>
                <span className="cn-safe-i">
                  <Icon name="laptop" size={15} />
                </span>
                <span>
                  <b>You connect the Mac.</b> The agent installs the app; you approve it here with the code your Mac shows.
                </span>
              </li>
              <li className="rv-i" style={slot(5)}>
                <span className="cn-safe-i">
                  <Icon name="eye" size={15} />
                </span>
                <span>
                  <b>Open source.</b> Read what it installs:{' '}
                  <a className="cn-l" href={REPO_URL} target="_blank" rel="noreferrer">
                    github.com/kroufekd/pingme
                  </a>
                </span>
              </li>
            </ul>
          </div>
        </div>
        <span className="vh" role="status" aria-live="polite">
          {copied ? COPIED : ''}
        </span>
      </div>
      {below}
    </div>
  )
}
