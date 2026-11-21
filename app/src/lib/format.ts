// The one place the UI turns instants, amounts, schedule times, durations and counts into text (P1, C1). Every function
// takes a `Display` (`{ timeZone, locale }`), read from one selector (src/state/display.ts): the demo passes the device's
// zone and en-US, so nothing changes on screen; the product passes the brand's zone from P2. The patterns are US
// ("8:03 AM", "Nov 16", "Mon, Nov 16", "$1,190") until Wasim decides the format for UK brands (Q9); the locale picks
// the month and weekday names and the number separators. `scripts/check-format.mjs` fails on `Intl`, `toLocale*` or
// the local getters (`getHours` and the rest) anywhere else in `src/` or `shared/` (the getters are allowed in the demo clock).
import type { ClockTime, Instant, Money, Prose } from '../../shared/contract/common'

export interface Display {
  /** An IANA time zone ("America/New_York"): the calendar day and time of day an instant shows as. */
  timeZone: string
  /** A BCP 47 locale ("en-US"): month and weekday names, digits and separators. */
  locale: string
}

/** An instant, or the same moment as an ISO 8601 string with its offset, or as epoch ms. Every one formats the same. */
export type At = Instant | string | number

/** The moment `at` names, as epoch ms. Throws on a string that isn't an ISO 8601 date and time with an offset. */
export const msOf = (at: At): number => {
  if (typeof at === 'number') return at
  if (typeof at !== 'string') return at.ms
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:\d\d)$/.test(at)) throw new Error(`Not an ISO 8601 date and time with an offset: "${at}"`)
  return Date.parse(at)
}

/** An instant from epoch ms, its `iso` in UTC. Lives here, not beside the schema, so the demo bundle never loads zod. */
export const instantOf = (ms: number): Instant => {
  if (!Number.isFinite(ms)) throw new Error(`Not a moment: ${ms}`)
  const at = Math.round(ms)
  return { iso: new Date(at).toISOString(), ms: at }
}

/** The device's own time zone: what the demo shows times in. */
export const deviceTimeZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone
/** Whether this browser takes `timeZone` as a time zone id. */
export const isTimeZone = (timeZone: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone }); return true } catch { return false } }

// ---------- the calendar in a time zone ----------

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>()
const dtf = (locale: string, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const k = `d|${locale}|${JSON.stringify(o)}`
  let f = cache.get(k) as Intl.DateTimeFormat | undefined
  if (!f) { f = new Intl.DateTimeFormat(locale, o); cache.set(k, f) }
  return f
}
const nf = (locale: string, o: Intl.NumberFormatOptions): Intl.NumberFormat => {
  const k = `n|${locale}|${JSON.stringify(o)}`
  let f = cache.get(k) as Intl.NumberFormat | undefined
  if (!f) { f = new Intl.NumberFormat(locale, o); cache.set(k, f) }
  return f
}

/** An instant's calendar date and time of day in a zone. `month` is 1 to 12, `weekday` 0 (Sunday) to 6. */
export interface Calendar { year: number; month: number; day: number; weekday: number; hour: number; minute: number }
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
export const calendarOf = (at: At, d: Display): Calendar => {
  // en-US with Latin digits whatever the display locale: these parts are read as numbers, never shown.
  const parts = dtf('en-US-u-nu-latn', {
    timeZone: d.timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(msOf(at))
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === t)?.value ?? ''
  return { year: Number(get('year')), month: Number(get('month')), day: Number(get('day')), weekday: WEEKDAY_INDEX[get('weekday')], hour: Number(get('hour')) % 24, minute: Number(get('minute')) }
}

/** Calendar days from `at` to `now` in the zone: 0 the same day, 1 the day before, -1 the day after. */
export const daysBefore = (at: At, now: At, d: Display): number => {
  const a = calendarOf(at, d), b = calendarOf(now, d)
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000)
}

/** The short month and weekday names in a locale ("Nov", "Mon"). */
const names = (locale: string) => {
  const months = Array.from({ length: 12 }, (_, m) => dtf(locale, { month: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, m, 15)))
  // 2026-11-15 was a Sunday.
  const weekdays = Array.from({ length: 7 }, (_, w) => dtf(locale, { weekday: 'short', timeZone: 'UTC' }).format(Date.UTC(2026, 10, 15 + w)))
  return { months, weekdays }
}
const namesCache = new Map<string, ReturnType<typeof names>>()
const namesOf = (locale: string) => {
  let n = namesCache.get(locale)
  if (!n) { n = names(locale); namesCache.set(locale, n) }
  return n
}

// ---------- instants ----------

/** "8:03 AM" from an hour (0 to 23) and minute, with a no-break space so a time never wraps between the digits and AM or PM. */
const clockText = (hour: number, minute: number) => `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')}\u00a0${hour < 12 ? 'AM' : 'PM'}`

/** "8:03 AM" */
export const fmtTime = (at: At, d: Display): string => {
  const c = calendarOf(at, d)
  return clockText(c.hour, c.minute)
}
/** "Nov 16" (no year, on purpose) */
export const fmtDay = (at: At, d: Display): string => {
  const c = calendarOf(at, d)
  return `${namesOf(d.locale).months[c.month - 1]} ${c.day}`
}
/** "Mon, Nov 16" */
export const fmtWeekday = (at: At, d: Display): string => `${namesOf(d.locale).weekdays[calendarOf(at, d).weekday]}, ${fmtDay(at, d)}`
/** "Tue, Nov 17 at 7:00 AM": a routine's next run. */
export const fmtWeekdayAt = (at: At, d: Display): string => `${fmtWeekday(at, d)} at ${fmtTime(at, d)}`
/** "Next run Tue, Nov 17 at 7:00 AM": under a routine card in a chat. */
export const fmtNextRun = (at: At, d: Display): string => `Next run ${fmtWeekdayAt(at, d)}`
/** "Mon, Nov 16, 7:43 AM": a file's full date. */
export const fmtWeekdayTime = (at: At, d: Display): string => `${fmtWeekday(at, d)}, ${fmtTime(at, d)}`

/** A date near `now`: the weekday and date within six days either side ("Fri, Nov 13"), else the date ("Nov 2"). */
export const fmtNearDay = (at: At, now: At, d: Display): string => (Math.abs(daysBefore(at, now, d)) <= 6 ? fmtWeekday(at, d) : fmtDay(at, d))
/** When, in a list: the time today ("7:42 AM"), else as `fmtNearDay` ("Sun, Nov 15", "Nov 2"). */
export const fmtWhen = (at: At, now: At, d: Display): string => (daysBefore(at, now, d) === 0 ? fmtTime(at, d) : fmtNearDay(at, now, d))
/** A day said in a sentence: "today", else as `fmtNearDay`. */
export const fmtDayWord = (at: At, now: At, d: Display): string => (daysBefore(at, now, d) === 0 ? 'today' : fmtNearDay(at, now, d))
/** The group a chat sits in: "Today", "Yesterday", "Last 7 days" (two to six days before) or "Earlier". */
export const fmtDayGroup = (at: At, now: At, d: Display): string => {
  const n = daysBefore(at, now, d)
  return n === 0 ? 'Today' : n === 1 ? 'Yesterday' : n >= 2 && n <= 6 ? 'Last 7 days' : 'Earlier'
}
/** The audit log's group in Settings: "Today" for today's changes, else "Earlier". */
export const fmtAuditDay = (at: At, now: At, d: Display): 'Today' | 'Earlier' => (daysBefore(at, now, d) === 0 ? 'Today' : 'Earlier')
/** How long ago something was sent: "just now" within the hour, else as `fmtWhen`. */
export const fmtAgo = (at: At, now: At, d: Display): string => {
  const ago = msOf(now) - msOf(at)
  return ago >= -60_000 && ago < 3_600_000 ? 'just now' : fmtWhen(at, now, d)
}

/**
 * A sentence with times in it (`Prose`): each `{key:time}` becomes `fmtTime` of `times[key]` ("6:04 AM"), each
 * `{key:weekday}` `fmtWeekday` ("Thu, Nov 19"). Throws on a key with no time, so a sentence never shows a raw token.
 */
export const fmtProse = (p: Prose, d: Display): string => p.text.replace(/\{(\w+)(?::(\w+))?\}/g, (token, key: string, form?: string) => {
  const at = Object.hasOwn(p.times, key) ? p.times[key] : undefined
  if (!at || (form !== 'time' && form !== 'weekday')) throw new Error(`"${p.text}": ${token} needs a time in times.${key} and a form, time or weekday`)
  return form === 'time' ? fmtTime(at, d) : fmtWeekday(at, d)
})

// ---------- schedule times ----------

/** A schedule's time of day ("6:00 AM"), a wall-clock time in the brand's zone: the zone doesn't move it. */
export const fmtClock = (t: ClockTime, _d: Display): string => clockText(t.hour, t.minute)

// ---------- amounts and counts ----------

/** A count ("1,314"). Every number over 999 on screen goes through it. */
export const fmtCount = (n: number, d: Display): string => nf(d.locale, {}).format(n)

const minorDigits = (currency: string): number => nf('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
/** An amount in its major unit (12.5 for 1250 cents). */
export const majorOf = (m: Money): number => m.minor / 10 ** minorDigits(m.currency)
/** An amount from a number in the major unit (dollars): rounded to the minor unit. */
export const moneyOf = (major: number, currency: string): Money => ({ minor: Math.round(major * 10 ** minorDigits(currency)), currency })

export interface MoneyOptions {
  /** `auto` (the default): whole amounts show no cents ("$1,190", "$0.50"); `always`: cents always show ("$0.00", "$250.00"). */
  cents?: 'auto' | 'always'
  /** False for a typed field's saved value ("$1200.50"): no thousands separator. */
  grouping?: boolean
}
/** An amount: "$1,190", "$0.03", "$250.00". */
export const fmtMoney = (m: Money, d: Display, o: MoneyOptions = {}): string => {
  const digits = minorDigits(m.currency)
  const whole = m.minor % 10 ** digits === 0
  const frac = o.cents === 'always' || !whole ? digits : 0
  return nf(d.locale, { style: 'currency', currency: m.currency, minimumFractionDigits: frac, maximumFractionDigits: frac, useGrouping: o.grouping ?? true }).format(majorOf(m))
}
/** An amount on the Usage page, from a figure in the major unit (the page's sums and averages are in dollars): cents always show ("$182.43"). */
export const fmtUsageMoney = (major: number, currency: string, d: Display): string => fmtMoney(moneyOf(major, currency), d, { cents: 'always' })
/** Usage's spending cap line: "$182.43 of $500". */
export const fmtSpentOfCap = (spent: Money, cap: Money, d: Display): string => `${fmtUsageMoney(majorOf(spent), spent.currency, d)} of ${fmtMoney(cap, d)}`
/** Settings' "Monthly cap", a money field's value: no thousands separator ("$1200"). */
export const fmtCapSetting = (cap: Money, d: Display): string => fmtMoney(cap, d, { grouping: false })
/** Settings' "Spent so far": cents always, no thousands separator ("$1190.00"). */
export const fmtSpentSetting = (spent: Money, d: Display): string => fmtMoney(spent, d, { cents: 'always', grouping: false })

// ---------- durations ----------

/** How long a step or a run took: "820ms", "11.6s", "1m 5s". */
export const fmtDuration = (ms: number, d: Display): string => {
  const s = ms / 1000
  // Never grouped: 999.6 ms is "1000ms", not "1,000ms".
  if (s < 1) return nf(d.locale, { useGrouping: false, maximumFractionDigits: 0 }).format(Math.round(ms)) + 'ms'
  // Rounded before the unit is picked, so 59.96 s is "1m 0s", never "60s", and 119.6 s is "2m 0s", never "1m 60s".
  const tenths = Math.round(s * 10) / 10
  if (tenths < 60) return nf(d.locale, { maximumFractionDigits: 1 }).format(tenths) + 's'
  const whole = Math.round(s)
  return Math.floor(whole / 60) + 'm ' + (whole % 60) + 's'
}
/** A step on the trace window's time axis: its offset in ms from the start of the run, and its label ("0s", "5s", "1m 0s"). */
export interface TraceTick { ms: number; label: string }
/** The axis steps, in seconds: the first that gives at most about three steps over the run. */
const TICK_CANDIDATES = [0.5, 1, 2, 5, 10, 15, 20, 30, 50, 60, 100, 120]
/** The trace window's time axis over a run of `durationMs`: a tick at 0 and every step after, up to the run's end. */
export const traceTicks = (durationMs: number, d: Display): TraceTick[] => {
  const step = (TICK_CANDIDATES.find(c => durationMs / 1000 / c <= 3.2) ?? 120) * 1000
  const ticks: TraceTick[] = []
  for (let v = 0; v <= durationMs; v += step) ticks.push({ ms: v, label: v === 0 ? '0s' : fmtDuration(v, d) })
  return ticks
}

/**
 * A trace's cost. A model call still open (its step reads "<model> · in progress", the server's runs-read.ts) counts at
 * its admitted worst case until it closes, so the amount reads "up to …" while one is open.
 */
export const fmtTraceCost = (t: { cost: Money; steps: readonly { kind: string; detail: string }[] }, d: Display): string => {
  const shown = fmtMoney(t.cost, d, { cents: 'always' })
  const open = t.steps.some(s => s.kind === 'model' && (s.detail.split(' · ')[1] ?? '').startsWith('in progress'))
  return open ? `up to ${shown}` : shown
}

/** The line under an answer: mode, steps, time taken and when it answered, as far as they're known ("Balanced · 6 steps · 11.6s · 8:03 AM"). */
export const fmtAnswerBar = (a: { model?: string; steps: number; durationMs: number; at?: At }, d: Display): string =>
  [a.model, `${a.steps} steps`, fmtDuration(a.durationMs, d), a.at === undefined ? undefined : fmtTime(a.at, d)].filter(Boolean).join(' · ')

/** A recording's length: "1:36", "8:14". */
export const fmtMediaLength = (ms: number, _d: Display): string => {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
