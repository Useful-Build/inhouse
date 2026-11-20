// The brand's month and day (p3-design section 9): a turn's month is the calendar month in the brand's `g:tz` at its
// reservation, kept on the turn. Intl does the zone arithmetic, DST included.
import { TIME_ZONE_IDS } from '../../shared/contract/settings-table.ts'

/** The zone a brand that never set `g:tz` runs in: the Settings page's default (src/screens/settings/content.ts). */
export const DEFAULT_TZ = 'America/New_York'

/** A stored `g:tz` value (its JSON already parsed) as a zone; anything not on the Settings list is the default. */
export const zoneOf = (value: unknown): string =>
  typeof value === 'string' && (TIME_ZONE_IDS as readonly string[]).includes(value) ? value : DEFAULT_TZ

const formats = new Map<string, Intl.DateTimeFormat>()
const partsOf = (ms: number, tz: string) => {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    formats.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) }
}

/** `YYYY-MM` of the instant in the zone. */
export function monthOf(ms: number, tz: string): string {
  const { year, month } = partsOf(ms, tz)
  return `${year}-${String(month).padStart(2, '0')}`
}

/** The day of the month (1-31) of the instant in the zone. */
export const dayOf = (ms: number, tz: string): number => partsOf(ms, tz).day

export const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

/** How many days the `YYYY-MM` month has. */
export function daysIn(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** The month's English name, as the Usage page shows it ("November"). */
export const monthName = (month: string): string => NAMES[Number(month.slice(5, 7)) - 1]
