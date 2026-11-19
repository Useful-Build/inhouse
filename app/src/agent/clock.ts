// The demo's one clock and its formats (D5 in docs/history/UI_PLAN_2.md). Pure functions, no React.
// The demo runs on Monday, November 16, 2026 from 8:00 AM in the device's local time (the time zone in Settings is a
// label; it doesn't move this clock), moving on with real time while it is open and stopping at
// 11:59 AM so the morning stays a morning. Everything a person does is stamped on this clock, never the computer's own
// time. Holds and timers keep using real epoch ms. US formats: "8:03 AM", "Nov 16", "Mon, Nov 16".

/** Monday, November 16, 2026, 8:00 AM, in the device's local time. */
export const DEMO_START = new Date(2026, 10, 16, 8, 0, 0, 0)
/** The latest the demo clock reads: 11:59 AM the same morning. */
export const DEMO_LATEST = new Date(2026, 10, 16, 11, 59, 0, 0)

/** The demo's time now: DEMO_START plus the real time since `startedAt` (epoch ms), capped at DEMO_LATEST. */
export const demoNow = (startedAt: number, now: number = Date.now()): Date =>
  new Date(Math.min(DEMO_START.getTime() + Math.max(0, now - startedAt), DEMO_LATEST.getTime()))

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** "8:03 AM", with a no-break space so a time never wraps between the digits and AM or PM. Built by hand:
 *  `toLocaleTimeString` puts a narrow no-break space there in current browsers. */
export const fmtTime = (d: Date): string => {
  const h = d.getHours()
  return `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, '0')}\u00a0${h < 12 ? 'AM' : 'PM'}`
}
/** A count as shown: US thousands separators ("1,314"). Every number over 999 on screen goes through it. */
export const fmtCount = (n: number): string => n.toLocaleString('en-US')
/** "Nov 16" */
export const fmtDay = (d: Date): string => `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`
/** "Mon, Nov 16" */
export const fmtWeekday = (d: Date): string => `${WEEKDAYS[d.getDay()].slice(0, 3)}, ${fmtDay(d)}`
/** Minutes since midnight: the sortable value that goes next to a displayed time. Nothing sorts on a display string. */
export const minuteOf = (d: Date): number => d.getHours() * 60 + d.getMinutes()

/** A shown time ("6:04 AM", as `fmtTime` writes it) found in a text. */
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

/** A local date and time as the sample data writes it ("2026-11-16T06:08"). Throws on anything else. */
export const parseLocal = (iso: string): Date => {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)$/.exec(iso)
  if (!m) throw new Error(`Not a local date and time like 2026-11-16T06:08: "${iso}"`)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
}
