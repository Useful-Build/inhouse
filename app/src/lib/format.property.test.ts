// Properties of format.ts (P1, C1). The ways it could go wrong, written before the tests:
// 1. An instant given as `iso` formats differently from the same instant given as `ms`: an ISO offset ignored or
//    misread, or `ms` read in the device's zone instead of the `Display` zone.
// 2. The time of day or the calendar day comes from the device's zone, not `Display.timeZone`, so one instant shows the
//    same local time everywhere, or the date slips by a day near midnight.
// 3. Relative labels ("Today", "Yesterday", the weekday) count 24-hour spans instead of calendar days in the zone, so
//    they are off by one across midnight or a daylight saving change.
// 4. 12 AM and 12 PM, a minute under 10, or the no-break space before AM or PM come out wrong.
// 5. An amount loses or invents cents, or its thousands separator, or a minor-unit round trip changes it.
// 6. A duration at the 1 s or 60 s boundary switches unit at the wrong value.
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import {
  calendarOf, daysBefore, fmtAgo, fmtClock, fmtDay, fmtDayGroup, fmtDayWord, fmtDuration, fmtMoney, fmtNearDay, fmtTime, fmtWeekday, fmtWeekdayAt,
  fmtWeekdayTime, fmtWhen, instantOf, majorOf, moneyOf, type Display,
} from './format'

/** Zones with and without daylight saving, either side of UTC, one at a half hour and one at a 45-minute offset. */
const ZONES = ['UTC', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Auckland', 'America/Phoenix']
const display = fc.constantFrom(...ZONES).map((timeZone): Display => ({ timeZone, locale: 'en-US' }))
/** Moments from 2000 to 2040, whole ms. */
const ms = fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2040, 0, 1) })
/** An offset an ISO string may carry: whole quarter hours from -12:00 to +14:00. */
const offsetMin = fc.integer({ min: -48, max: 56 }).map(q => q * 15)

/** The same moment as an ISO 8601 string with the given offset ("2026-11-16T08:00:00.000-05:00"). */
const isoWithOffset = (at: number, off: number) => {
  const local = new Date(at + off * 60_000).toISOString().slice(0, 23)
  const sign = off < 0 ? '-' : '+'
  const a = Math.abs(off)
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

/** Every instant formatter, with `now` for the relative ones. */
const FORMATTERS: [string, (at: number | string | { iso: string; ms: number }, now: number, d: Display) => string][] = [
  ['fmtTime', (a, _n, d) => fmtTime(a, d)], ['fmtDay', (a, _n, d) => fmtDay(a, d)], ['fmtWeekday', (a, _n, d) => fmtWeekday(a, d)],
  ['fmtWeekdayAt', (a, _n, d) => fmtWeekdayAt(a, d)], ['fmtWeekdayTime', (a, _n, d) => fmtWeekdayTime(a, d)],
  ['fmtWhen', fmtWhen], ['fmtNearDay', fmtNearDay], ['fmtDayWord', fmtDayWord], ['fmtDayGroup', fmtDayGroup], ['fmtAgo', fmtAgo],
]

describe('instants', () => {
  test.prop([ms, offsetMin, ms, display])('iso (with any offset) and ms give the same text for one instant', (at, off, now, d) => {
    const iso = isoWithOffset(at, off)
    expect(Date.parse(iso)).toBe(at)
    for (const [name, f] of FORMATTERS) {
      const fromMs = f(at, now, d)
      expect(f(iso, now, d), name).toBe(fromMs)
      expect(f(instantOf(at), now, d), name).toBe(fromMs)
    }
  })

  test.prop([ms])('one instant shows the right local time in zones with a fixed offset', at => {
    // Kolkata is always UTC+5:30 and Phoenix UTC-7 (no daylight saving): the local time is the UTC time moved by that.
    for (const [timeZone, offset] of [['Asia/Kolkata', 330], ['America/Phoenix', -420], ['UTC', 0]] as const) {
      const local = new Date(at + offset * 60_000)
      const h = local.getUTCHours(), m = local.getUTCMinutes()
      const want = `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`
      expect(fmtTime(at, { timeZone, locale: 'en-US' })).toBe(want)
      const c = calendarOf(at, { timeZone, locale: 'en-US' })
      expect([c.year, c.month, c.day, c.weekday]).toEqual([local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate(), local.getUTCDay()])
    }
  })

  test('one instant in two zones: the demo morning in New York is the afternoon in London, and the next day in Auckland', () => {
    const at = Date.UTC(2026, 10, 16, 13, 0) // 8:00 AM in New York (UTC-5 in November)
    const ny: Display = { timeZone: 'America/New_York', locale: 'en-US' }
    const london: Display = { timeZone: 'Europe/London', locale: 'en-US' }
    const auckland: Display = { timeZone: 'Pacific/Auckland', locale: 'en-US' }
    expect(fmtWeekdayTime(at, ny)).toBe('Mon, Nov 16, 8:00 AM')
    expect(fmtWeekdayTime(at, london)).toBe('Mon, Nov 16, 1:00 PM')
    expect(fmtWeekdayTime(at, auckland)).toBe('Tue, Nov 17, 2:00 AM')
    // Across the US change back to standard time (Nov 1, 2026): 9:00 AM local on both sides.
    expect(fmtTime(Date.UTC(2026, 9, 31, 13, 0), ny)).toBe('9:00 AM')
    expect(fmtTime(Date.UTC(2026, 10, 2, 14, 0), ny)).toBe('9:00 AM')
  })

  test.prop([ms, fc.integer({ min: -40, max: 40 }), display])('relative labels count calendar days in the zone, not 24-hour spans', (now, days, d) => {
    // A moment `days` calendar days earlier in the zone.
    let at = now - days * 86_400_000
    // A daylight saving change in between moves the wall clock by up to an hour: step back onto the same calendar day.
    for (let i = 0; i < 4 && daysBefore(at, now, d) !== days; i++) at += (daysBefore(at, now, d) > days ? 1 : -1) * 3_600_000
    const n = daysBefore(at, now, d)
    expect(n).toBe(days)
    expect(fmtDayGroup(at, now, d)).toBe(n === 0 ? 'Today' : n === 1 ? 'Yesterday' : n >= 2 && n <= 6 ? 'Last 7 days' : 'Earlier')
    expect(fmtWhen(at, now, d)).toBe(n === 0 ? fmtTime(at, d) : Math.abs(n) <= 6 ? fmtWeekday(at, d) : fmtDay(at, d))
  })

  test.prop([fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), display])('a schedule time reads the same in every zone', (hour, minute, d) => {
    const want = `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
    expect(fmtClock({ hour, minute }, d)).toBe(want)
  })
})

describe('amounts and durations', () => {
  const d: Display = { timeZone: 'UTC', locale: 'en-US' }
  test.prop([fc.integer({ min: 0, max: 1e11 })])('an amount shows every cent it has, and whole dollars none unless asked', minor => {
    const m = { minor, currency: 'USD' }
    const auto = fmtMoney(m, d), always = fmtMoney(m, d, { cents: 'always' }), plain = fmtMoney(m, d, { grouping: false })
    expect(always).toMatch(/^\$\d{1,3}(,\d{3})*\.\d\d$/)
    expect(auto).toBe(minor % 100 === 0 ? always.slice(0, -3) : always)
    expect(plain).toBe(auto.replaceAll(',', ''))
    // The digits are the amount: nothing rounded or lost.
    expect(Number(always.replace(/[$,]/g, '')) * 100).toBeCloseTo(minor, 0)
    expect(moneyOf(majorOf(m), 'USD')).toEqual(m)
  })

  test.prop([fc.integer({ min: 0, max: 600_000 })])('a duration is ms under 1 s, tenths of a second under a minute, then minutes and seconds', t => {
    const out = fmtDuration(t, d)
    if (t < 1000) expect(out).toBe(`${t}ms`)
    // 59.95 s rounds to 60 s, a whole minute: from there it is minutes and seconds.
    else if (t < 59_950) expect(out).toMatch(/^([1-9]|[1-5]\d)(\.\d)?s$/)
    // Seconds 0 to 59: never "60s" or "1m 60s".
    else expect(out).toMatch(/^[1-9]\d*m [1-5]?\ds$/)
  })
  test('a duration that rounds up to the next minute shows it (failure 6)', () => {
    expect(fmtDuration(59_960, d)).toBe('1m 0s')
    expect(fmtDuration(119_600, d)).toBe('2m 0s')
    expect(fmtDuration(59_940, d)).toBe('59.9s')
  })
})
