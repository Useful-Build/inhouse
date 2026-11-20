// Text helpers and the readers of times saved before C1. Pure functions, no React. Formatting lives in
// src/lib/format.ts; the demo's own clock is in demo-clock.ts (only the demo entry and the mock import it).

import type { ClockTime, Instant } from '../../shared/contract/common'
import { instantOf } from '../lib/format'

/** A shown time ("6:04 AM", as `fmtTime` in format.ts writes it) found in a text. */
export const TIME_RE = /\b(1[0-2]|[1-9]):([0-5]\d)[ \u00a0](AM|PM)\b/

/** Text leaving the screen (a copy, a CSV, a search): no-break spaces become plain ones, so "6:04 AM" typed or pasted matches. */
export const plainSpaces = (s: string): string => s.replaceAll('\u00a0', ' ')

/** A number kept with its unit at a line break ("3 days"). For display only: data and search text keep plain spaces. */
export const keepUnitsTogether = (s: string): string => s.replace(/(\d) (days?|things)\b/g, '$1\u00a0$2')

/** Every shown time in `x` (a string, or any JSON value's strings) with a no-break space before AM or PM, as `fmtTime` writes it. */
export const keepTimesTogether = <T,>(x: T): T => {
  if (typeof x === 'string') return x.replace(/(\d) (AM|PM)\b/g, '$1\u00a0$2') as T
  if (Array.isArray(x)) return x.map(keepTimesTogether) as T
  if (typeof x === 'object' && x !== null) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, keepTimesTogether(v)])) as T
  return x
}
/** Minutes since midnight of the first shown time ("6:04 AM") in a text. Throws when there is none. */
export const minuteOfTime = (text: string): number => {
  const m = TIME_RE.exec(text)
  if (!m) throw new Error(`No time like "6:04 AM" in "${text}"`)
  return (Number(m[1]) % 12 + (m[3] === 'PM' ? 12 : 0)) * 60 + Number(m[2])
}

/**
 * A routine's next run after `now`: the first day from `now` on whose weekday (0 Sunday to 6 Saturday) `runsOn` takes, at
 * `hour`:`minute` in the device's local time. Local like the rest of the demo clock until P2 moves it onto the brand's zone.
 */
export const nextLocalRun = (hour: number, minute: number, now: Date, runsOn: (weekday: number) => boolean): Instant => {
  const d = new Date(now)
  d.setHours(hour, minute, 0, 0)
  while (!(d > now && runsOn(d.getDay()))) d.setDate(d.getDate() + 1)
  return instantOf(d.getTime())
}

// ---------- times saved as they showed, before C1 ----------

/** A time saved as it showed ("8:03 AM"), on the day of `base` in the device's local time. Null when it isn't one. */
export const shownTimeOn = (text: string, base: Date): Instant | null => {
  const m = TIME_RE.exec(text)
  if (!m) return null
  return instantOf(new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minuteOfTime(m[0])).getTime())
}
/** A schedule time saved as it showed ("7:00 AM"). Null when it isn't one. */
export const shownClock = (text: string): ClockTime | null => {
  if (!TIME_RE.test(text)) return null
  const min = minuteOfTime(text)
  return { hour: Math.floor(min / 60), minute: min % 60 }
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** A date and time saved as it showed ("Next run Mon, Nov 23 at 7:00 AM"), in the year of `base`. Null when it isn't one. */
export const shownDateTimeIn = (text: string, base: Date): Instant | null => {
  const m = /\b([A-Z][a-z]{2}) (\d{1,2}) at (.+)$/.exec(text)
  if (!m || !MONTHS.includes(m[1]) || !TIME_RE.test(m[3])) return null
  return instantOf(new Date(base.getFullYear(), MONTHS.indexOf(m[1]), Number(m[2]), 0, minuteOfTime(m[3])).getTime())
}
