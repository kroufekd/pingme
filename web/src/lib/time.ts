import { useEffect, useState } from 'react'

const DAY = 86_400_000
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export type Repeat = 'daily' | 'weekdays' | 'weekly' | 'biweekly' | 'monthly'

/** "9:30", "18:00" */
export function clock(ms: number) {
  const d = new Date(ms)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

function startOfDay(ms: number) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** When a planned task pops up: "18:00" today, "tomorrow 9:30", "Tue 18:00" this week, "24/11" later. */
export function dueLabel(ms: number, now: number) {
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY)
  if (days === 0) return clock(ms)
  if (days === 1) return `tomorrow ${clock(ms)}`
  if (days > 1 && days < 7) return `${DAY_SHORT[new Date(ms).getDay()]} ${clock(ms)}`
  const d = new Date(ms)
  return `${d.getDate()}/${d.getMonth() + 1}`
}

/** A snoozed task: "in 10 min" while it is close, "until 14:12" otherwise. */
export function snoozeLabel(until: number | undefined, now: number) {
  if (until === undefined) return 'snoozed'
  const minutes = Math.ceil((until - now) / 60_000)
  if (minutes >= 1 && minutes <= 60) return `in ${minutes} min`
  return `until ${clock(until)}`
}

/** Local day as "YYYY-MM-DD", the value of a date input. */
export function dayKey(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "HH:MM", the value of a time input. */
export function timeKey(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** A day from a date input and a time from a time input, as local time. */
export function dateTime(day: string, hhmm: string) {
  const [y, mo, d] = day.split('-').map(Number)
  const [h, m] = hhmm.split(':').map(Number)
  if (![y, mo, d, h, m].every(Number.isInteger)) return null
  const ms = new Date(y, mo - 1, d, h, m, 0, 0).getTime()
  return Number.isNaN(ms) ? null : ms
}

/** Default for "Later": an hour from now, on a 5 minute step. */
export function laterDefault(now: number) {
  const step = 5 * 60_000
  return Math.ceil((now + 60 * 60_000) / step) * step
}

export const MAX_DAYS = 60
export const DAY_MS = DAY

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
