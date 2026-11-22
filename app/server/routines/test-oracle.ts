// The brute-force slot oracle (p4-w2.md test 1), shared by the slot property and the one-run-per-slot model: it walks
// every UTC minute with its own Intl formatter and applies the rules in words. It shares no code with slots.ts. Test
// code only.
export const MIN = 60_000
export const DAY = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()
/** The oracle's own wall clock: `YYYY-MM-DD HH:MM`. */
export function wall(ms: number, tz: string): string {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatters.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`
}

/**
 * The rules in words, by walking minutes: for each local date on a scheduled weekday, the first minute whose wall time
 * is `date HH:MM`; if no minute has it, the first minute whose wall time is later. One per date. Kept if in (from, to].
 */
export function oracle(tz: string, mask: number, hhmm: string, from: number, to: number, routineId = 'rt_AAAAAAAAAAAAAAAAAAAAAA'): { key: string; dueAtMs: number }[] {
  const start = Math.floor((from - 2 * DAY) / MIN) * MIN
  const end = to + DAY
  const exact = new Map<string, number>()
  const later = new Map<string, number>()
  const dates: string[] = []
  for (let t = start; t <= end; t += MIN) {
    const w = wall(t, tz)
    const date = w.slice(0, 10)
    if (!dates.includes(date)) dates.push(date)
    // A date's target is reached on its own day or the next: only the newest dates can still match.
    for (const d of dates.slice(-3)) {
      const target = `${d} ${hhmm}`
      if (w === target && !exact.has(d)) exact.set(d, t)
      if (w > target && !later.has(d)) later.set(d, t)
    }
  }
  const out: { key: string; dueAtMs: number }[] = []
  // Dates whose target is after the walk's start (the first day may have begun before it).
  for (const d of dates.slice(1)) {
    const isoDay = (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7
    if ((mask & (1 << isoDay)) === 0) continue
    const due = exact.get(d) ?? later.get(d)
    if (due !== undefined && due > from && due <= to) out.push({ key: `${routineId}|${d}|${hhmm}`, dueAtMs: due })
  }
  return out.sort((a, b) => a.dueAtMs - b.dueAtMs)
}

