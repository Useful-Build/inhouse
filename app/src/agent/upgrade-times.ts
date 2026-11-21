// The readers of times a demo saved before C1 (P1): a time, a schedule time or a date as it showed ("8:03 AM",
// "Next run Mon, Nov 23 at 7:00 AM"), turned into an instant or a clock time. The mock and the store read old saves with
// them. They build dates in the device's local time, as the demo clock did when those times were saved, so this file and
// demo-clock.ts are the only ones scripts/check-format.mjs lets build a date by hand.

import type { ClockTime, Instant } from '../../shared/contract/common'
import { instantOf } from '../lib/format'
import { minuteOfTime, TIME_RE } from './clock'

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
