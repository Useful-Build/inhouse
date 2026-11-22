// Slot math (p4-w2.md section 3): which scheduled occurrences of a routine fall in a window, in the brand's zone. Pure:
// the zone arrives as a function from an instant to its wall time (`intlZone`, Intl's formatToParts with `hourCycle:
// 'h23'`). No hand-written offsets or zone tables: an instant for a wall time is found by trying the offsets the zone
// itself reports around that day, then a binary search across a spring-forward gap.
// Intl.DateTimeFormat `timeZone`: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
// Workers support Intl (https://developers.cloudflare.com/workers/runtime-apis/web-standards/); both read 2026-11-21. The
// workerd fixture test (slots.workers.test.ts) proves the runtime has the zone data.

export interface Schedule {
  /** Bit 0 Monday ... bit 6 Sunday (ISO weekdays). */
  days_mask: number
  hour: number
  minute: number
}

export interface Slot {
  key: string
  /** The brand's local date the slot belongs to, `YYYY-MM-DD`. */
  localDate: string
  /** The scheduled local time, `HH:MM` (kept for a skipped time: the key never names the instant). */
  localTime: string
  dueAtMs: number
}

/** A wall time: the local date and time of an instant in a zone, to the minute. */
export interface Wall {
  date: string
  time: string
}

/** An instant's wall time in one zone. */
export type ZoneFn = (ms: number) => Wall

const MINUTE = 60_000
const DAY = 86_400_000
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** The zone as a wall-time function. Throws `RangeError` for a zone the runtime doesn't know (fail loud). */
export function intlZone(tz: string): ZoneFn {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  return ms => {
    const p: Record<string, string> = {}
    for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value
    return { date: `${pad(Number(p.year), 4)}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }
  }
}

const wallText = (w: Wall) => `${w.date} ${w.time}`
const floorMinute = (ms: number) => Math.floor(ms / MINUTE) * MINUTE
/** The UTC instant whose UTC wall time is this local one (the "guess" before any offset). */
const asUtc = (date: string, time: string) => Date.parse(`${date}T${time}:00Z`)
/** The zone's offset at an instant, in ms (local wall minus UTC), to the minute. */
const offsetAt = (zone: ZoneFn, ms: number) => {
  const w = zone(ms)
  return asUtc(w.date, w.time) - floorMinute(ms)
}

/**
 * The instant a slot is due: the first instant whose wall time is `date time`; if none has it (spring forward), the
 * first instant whose wall time is later than it. Two instants with it (fall back): the first.
 */
export function instantOf(zone: ZoneFn, date: string, time: string): number {
  const target = `${date} ${time}`
  const guess = asUtc(date, time)
  const offsets = new Set([offsetAt(zone, guess - DAY), offsetAt(zone, guess), offsetAt(zone, guess + DAY)])
  const candidates = [...offsets].map(o => guess - o).sort((a, b) => a - b)
  const exact = candidates.find(t => wallText(zone(t)) === target)
  if (exact !== undefined) return exact
  // A gap: the wall time jumps over the target between the earliest and latest candidate. Find the first minute past it.
  let lo = candidates[0]
  let hi = candidates[candidates.length - 1]
  if (!(wallText(zone(lo)) < target && wallText(zone(hi)) > target)) throw new Error(`instantOf: no instant for ${target}`)
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / MINUTE / 2) * MINUTE
    if (wallText(zone(mid)) > target) hi = mid
    else lo = mid
  }
  return hi
}

/** The ISO weekday bit (0 Monday ... 6 Sunday) of a `YYYY-MM-DD` date. */
export const weekdayBit = (date: string): number => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7

const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10)
export const prevDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10)

export const slotKey = (routineId: string, date: string, time: string): string => `${routineId}|${date}|${time}`
export const scheduledTime = (r: Schedule): string => `${pad(r.hour)}:${pad(r.minute)}`

/**
 * Every slot of `r` whose due instant is in `(fromMs, toMs]`, oldest first. One per local date and scheduled time: the
 * key keeps the scheduled `HH:MM`, so a skipped time keeps its key and a repeated one has one key.
 */
export function slotsDue(r: Schedule & { id: string }, tz: string, fromMs: number, toMs: number, zone: ZoneFn = intlZone(tz)): Slot[] {
  if (toMs <= fromMs) return []
  const time = scheduledTime(r)
  const last = zone(toMs).date
  const out: Slot[] = []
  // From the day before `fromMs`'s local date: a skipped time can carry a slot's instant past its own date.
  for (let date = prevDate(zone(fromMs).date); date <= last; date = nextDate(date)) {
    if ((r.days_mask & (1 << weekdayBit(date))) === 0) continue
    const dueAtMs = instantOf(zone, date, time)
    if (dueAtMs > fromMs && dueAtMs <= toMs) out.push({ key: slotKey(r.id, date, time), localDate: date, localTime: time, dueAtMs })
  }
  return out.sort((a, b) => a.dueAtMs - b.dueAtMs)
}

/** The first slot due after `fromMs`, looking `withinMs` ahead (null if none). */
export const nextSlot = (r: Schedule & { id: string }, tz: string, fromMs: number, withinMs: number, zone?: ZoneFn): Slot | null =>
  slotsDue(r, tz, fromMs, fromMs + withinMs, zone)[0] ?? null
