// What the P4 Watch specs (e2e/api/{routines,today,activity,bell,library,hub}.spec.ts) compute without a browser or a
// request: the brand's local wall clock of an instant, a literal 2026 and 2027 offset table for two zones (an oracle that
// shares no code with server/routines/slots.ts), the next run a daily schedule must show, and a leak scan.
// Pure, so e2e/support/watch-pure.test.ts runs it in the unit suite.

export interface LocalClock {
  /** `YYYY-MM-DD` in the zone. */
  date: string
  hour: number
  minute: number
}

/** The zone's wall clock at an instant, from Intl (the spec's own clock: the slot math under test is the server's). */
export function localClock(ms: number, tz: string): LocalClock {
  const parts: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) parts[p.type] = p.value
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}

/** The zones the brand's `g:tz` setting accepts that the offset table below covers. */
export type TableZone = 'America/New_York' | 'Europe/London'

/**
 * The instants (UTC) at which each zone's offset changes in 2026 and 2027, with the offset in minutes from then on. Written
 * from the zones' rules (New York: second Sunday of March at 02:00 and first Sunday of November at 02:00 local; London: last
 * Sunday of March at 01:00 UTC and of October at 01:00 UTC), never read from Intl. The offset before the first row is the
 * winter one.
 */
const TRANSITIONS: Record<TableZone, { fromMs: number; offsetMin: number }[]> = {
  'America/New_York': [
    { fromMs: Date.UTC(2026, 2, 8, 7), offsetMin: -240 },
    { fromMs: Date.UTC(2026, 10, 1, 6), offsetMin: -300 },
    { fromMs: Date.UTC(2027, 2, 14, 7), offsetMin: -240 },
    { fromMs: Date.UTC(2027, 10, 7, 6), offsetMin: -300 },
  ],
  'Europe/London': [
    { fromMs: Date.UTC(2026, 2, 29, 1), offsetMin: 60 },
    { fromMs: Date.UTC(2026, 9, 25, 1), offsetMin: 0 },
    { fromMs: Date.UTC(2027, 2, 28, 1), offsetMin: 60 },
    { fromMs: Date.UTC(2027, 9, 31, 1), offsetMin: 0 },
  ],
}
const WINTER: Record<TableZone, number> = { 'America/New_York': -300, 'Europe/London': 0 }
const SUMMER: Record<TableZone, number> = { 'America/New_York': -240, 'Europe/London': 60 }
/** The table's first and last covered instants: outside them `offsetMinutes` refuses to answer. */
export const TABLE_COVERS = { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2027, 11, 31) } as const

/** The zone's offset at an instant, in minutes, from the literal table (2026 and 2027 only; anything else throws). */
export function offsetMinutes(tz: TableZone, ms: number): number {
  if (ms < TABLE_COVERS.fromMs || ms > TABLE_COVERS.toMs) throw new Error(`the offset table covers 2026 and 2027, not ${new Date(ms).toISOString()}`)
  let offset = WINTER[tz]
  for (const t of TRANSITIONS[tz]) if (ms >= t.fromMs) offset = t.offsetMin
  return offset
}

/**
 * The first instant after `afterMs` at which a daily routine at `hour:minute` runs in the zone, from the literal table: the
 * smallest `date + hour:minute - offset` (one of the zone's two offsets) that the table says is really that zone's offset
 * then. Only for a time that is neither skipped nor repeated on the days searched (06:00 is not, in either zone).
 */
export function expectedNextDaily(tz: TableZone, hour: number, minute: number, afterMs: number): number {
  const start = new Date(afterMs)
  let best: number | null = null
  for (let d = -1; d <= 3; d++) {
    for (const off of [WINTER[tz], SUMMER[tz]]) {
      const at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + d, hour, minute) - off * 60_000
      if (at > afterMs && offsetMinutes(tz, at) === off && (best === null || at < best)) best = at
    }
  }
  if (best === null) throw new Error('no run found in the days searched')
  return best
}

/** The needles found in a text: names of the entries of `needles` (a string is found by `includes`, a RegExp by `test`). */
export function leaks(text: string, needles: Record<string, string | RegExp>): string[] {
  return Object.entries(needles).filter(([, n]) => (typeof n === 'string' ? text.includes(n) : n.test(text))).map(([name]) => name)
}
