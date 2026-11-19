// The demo's one clock (D5 in docs/history/UI_PLAN_2.md) and a few text helpers. Pure functions, no React. Formatting
// lives in src/lib/format.ts.
// The demo runs on Monday, November 16, 2026 from 8:00 AM in the device's local time (the time zone in Settings is a
// label; it doesn't move this clock), moving on with real time while it is open and stopping at
// 11:59 AM so the morning stays a morning. Everything a person does is stamped on this clock, never the computer's own
// time. Holds and timers keep using real epoch ms.

import type { ClockTime, Instant } from '../../shared/contract/common'
import { instantOf } from '../lib/format'

/** Monday, November 16, 2026, 8:00 AM, in the device's local time. */
export const DEMO_START = new Date(2026, 10, 16, 8, 0, 0, 0)
/** The latest the demo clock reads: 11:59 AM the same morning. */
export const DEMO_LATEST = new Date(2026, 10, 16, 11, 59, 0, 0)

/** The demo's time now: DEMO_START plus the real time since `startedAt` (epoch ms), capped at DEMO_LATEST. */
export const demoNow = (startedAt: number, now: number = Date.now()): Date =>
  new Date(Math.min(DEMO_START.getTime() + Math.max(0, now - startedAt), DEMO_LATEST.getTime()))

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

/** A sample instant as the sample data writes it: days from the demo's Monday and a local time ("0d 07:42" today,
 *  "-1d 16:40" Sunday, "+4d 09:00" Friday). Local, so it reads the same in every time zone. Throws on anything else. */
export const demoAt = (rel: string): Instant => {
  const m = /^([+-]?\d+)d (\d\d):(\d\d)$/.exec(rel)
  if (!m || Number(m[2]) > 23 || Number(m[3]) > 59) throw new Error(`Not a sample time like "-1d 16:40": "${rel}"`)
  return instantOf(new Date(DEMO_START.getFullYear(), DEMO_START.getMonth(), DEMO_START.getDate() + Number(m[1]), Number(m[2]), Number(m[3])).getTime())
}
/** The demo's Monday at a minute since midnight: how a time stored before C1 ("8:03 AM", minute 483) becomes an instant. */
export const demoDayAt = (minute: number): Instant =>
  instantOf(new Date(DEMO_START.getFullYear(), DEMO_START.getMonth(), DEMO_START.getDate(), 0, minute).getTime())

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
