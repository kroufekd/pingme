import { useMutation } from 'convex/react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { isOnline } from '@/lib/network'
import type { MyDevice } from '@/lib/network'
import { slot } from './connect'
import { Icon } from './icon'

export const DEVICES = 'Devices'
export const REMOVE = 'Remove'
export const NEW_MAC = 'New Mac'
export const MINE = "It's mine"
export const CONNECTED = 'Connected'
const THIS = 'This browser'
const NO_MAC = 'No Mac yet. Connect your agent to set one up.'
const SEEN_KEY = 'pingme:seen-macs'
const ARM_MS = 4000
/** A Mac that joined in the last week is announced on the browsers that were there before it. */
export const NOTICE_MS = 7 * 24 * 60 * 60_000

/**
 * Macs that joined the account after this browser and recently, not yet confirmed here.
 * A Mac on your account reads every ping to you, so a new one must never arrive silently.
 */
export function newMacs(devices: MyDevice[], thisId: string | null, now: number, seen: ReadonlySet<string>): MyDevice[] {
  const self = thisId ? devices.find((d) => d.deviceId === thisId) : undefined
  if (!self) return []
  return devices.filter((d) => d.kind === 'mac' && d.createdAt > self.createdAt && now - d.createdAt < NOTICE_MS && !seen.has(d.deviceId))
}

// Per browser: storage can be missing or throw (private mode); then the notice simply shows again.
function loadSeen(): Set<string> {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]')
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-50)))
  } catch {
    // Not remembered; harmless.
  }
}

const day = (ms: number) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'numeric' })

/** "New Mac" at the top of the page, until the person says it is theirs or removes it. */
export function NewMacNotice({ devices, thisId, now }: { devices: MyDevice[]; thisId: string | null; now: number }) {
  const revoke = useMutation(api.devices.revoke)
  // Read after mount: the server render has no storage.
  const [seen, setSeen] = useState<Set<string> | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => setSeen(loadSeen()), [])

  const mac = seen ? newMacs(devices, thisId, now, seen)[0] : undefined
  if (!mac || !seen) return null

  function settle(id: string) {
    const next = new Set(seen)
    next.add(id)
    saveSeen(next)
    setSeen(next)
  }

  async function remove(id: string) {
    if (busy) return
    setBusy(true)
    try {
      await revoke({ deviceId: id })
      settle(id)
    } catch {
      // Offline: the notice stays, so it can be tried again.
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dv-new" role="status" aria-label={NEW_MAC}>
      <span className="dv-new-i">
        <Icon name="laptop" size={18} />
      </span>
      <p className="dv-new-t">
        <span>{NEW_MAC}</span> <b>{mac.name}</b> <span className="dv-meta">{day(mac.createdAt)}</span>
      </p>
      <span className="dv-new-a">
        <button type="button" className="chip" onClick={() => settle(mac.deviceId)} disabled={busy}>
          {MINE}
        </button>
        <button type="button" className="chip dv-rm on" onClick={() => void remove(mac.deviceId)} disabled={busy} aria-label={`${REMOVE} ${mac.name}`}>
          {REMOVE}
        </button>
      </span>
    </div>
  )
}

/** How a device is doing, for its row: a Mac that synced in the last minutes reads as connected. */
export function deviceStatus(d: MyDevice, now: number): { on: boolean; text: string } {
  if (d.kind === 'mac' && isOnline(d.lastSeen, now)) return { on: true, text: CONNECTED }
  return { on: false, text: `Seen ${sameDay(d.lastSeen, now) ? 'today' : day(d.lastSeen)}` }
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString()

/**
 * The devices on the account, with a way to remove the ones that are not yours. This browser is
 * not a row: it is the page you are on, named once at the bottom, so a single paired Mac reads
 * as one device. Returns the toggle and the panel apart: the toggle sits at the right end of the
 * row with "Connect your agent" and the panel opens under that row, so it moves nothing above it.
 */
export function useDeviceList(devices: MyDevice[], thisId: string | null, now: number, open: boolean, onOpenChange: (open: boolean) => void) {
  const revoke = useMutation(api.devices.revoke)
  // The first click arms the remove button, the second removes: one slip must not unpair a Mac.
  const [armed, setArmed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(null), ARM_MS)
    return () => clearTimeout(t)
  }, [armed])

  useEffect(() => {
    if (!open) setArmed(null)
  }, [open])

  const self = thisId ? devices.find((d) => d.deviceId === thisId) : undefined
  // Newest first, so a Mac nobody expected is at the top.
  const others = useMemo(() => devices.filter((d) => d.deviceId !== thisId).sort((a, b) => b.createdAt - a.createdAt), [devices, thisId])
  const connected = others.some((d) => deviceStatus(d, now).on)

  async function remove(d: MyDevice) {
    if (armed !== d.deviceId) {
      setArmed(d.deviceId)
      return
    }
    if (busy) return
    setBusy(true)
    try {
      await revoke({ deviceId: d.deviceId })
      // The row goes away with the next query result; keep the keyboard somewhere sensible.
      toggleRef.current?.focus()
    } catch {
      // Offline: the row stays.
    } finally {
      setArmed(null)
      setBusy(false)
    }
  }

  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      className="cn-b dv-b"
      aria-expanded={open}
      aria-controls={id}
      aria-label={`${DEVICES} ${others.length}${connected ? `, ${CONNECTED}` : ''}`}
      onClick={() => onOpenChange(!open)}
    >
      <span className="dv-b-i" aria-hidden="true">
        <Icon name="laptop" size={16} />
        {connected && <span className="dv-b-dot" />}
      </span>
      <span className="dv-b-t" aria-hidden="true">
        {DEVICES}
      </span>
      <span className="dv-n" aria-hidden="true">
        {others.length}
      </span>
    </button>
  )

  const panel = (
    <div
      className={open ? 'rv dv-p on' : 'rv dv-p'}
      id={id}
      inert={!open}
      aria-hidden={!open || undefined}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        onOpenChange(false)
        toggleRef.current?.focus()
      }}
    >
      <div className="rv-c">
        <div className="rv-card dv-card">
          <ul className="dv-list" aria-label={DEVICES}>
            {others.length === 0 && (
              <li className="dv-none rv-i" style={slot(0)}>
                {NO_MAC}
              </li>
            )}
            {others.map((d, i) => {
              const on = armed === d.deviceId
              const status = deviceStatus(d, now)
              return (
                <li key={d.deviceId} className="dv-row rv-i" style={slot(i)}>
                  <span className="dv-row-i">
                    <Icon name={d.kind === 'mac' ? 'laptop' : 'globe'} size={18} />
                  </span>
                  <span className="dv-name">{d.name}</span>
                  <span className={status.on ? 'dv-st on' : 'dv-st'}>
                    <span className="dv-dot" aria-hidden="true" />
                    {status.text}
                  </span>
                  <span className="dv-act">
                    <button
                      type="button"
                      className={on ? 'chip dv-rm on' : 'chip dv-rm'}
                      onClick={() => void remove(d)}
                      disabled={busy}
                      aria-label={on ? `Confirm: ${REMOVE} ${d.name}` : `${REMOVE} ${d.name}`}
                      title={REMOVE}
                    >
                      {on ? <span>{REMOVE}</span> : <Icon name="x" size={16} />}
                    </button>
                  </span>
                </li>
              )
            })}
          </ul>
          {self && (
            <p className="dv-this rv-i" style={slot(Math.max(1, others.length))}>
              <Icon name="globe" size={15} />
              <span>
                {THIS}: <span className="dv-this-n">{self.name}</span>
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  )

  return { toggle, panel }
}
