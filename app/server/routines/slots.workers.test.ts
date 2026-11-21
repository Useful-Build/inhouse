// Slot math (p4-w2.md section 3; tests 1 to 3). Runs in workerd (the `server` project), so the literal DST fixtures
// also prove the runtime's Intl carries the zone data. Ways it can fail, written down first:
//  - a skipped wall time (spring forward) gets no slot, or one at the wrong instant (not the next valid minute);
//  - a repeated wall time (fall back) gets two slots, or the second instant;
//  - a transition at local midnight (Havana, Cairo) or a 30-minute shift (Lord Howe) breaks the per-date loop;
//  - a slot lands on a day its mask doesn't name, or a window's edges are open or closed the wrong way.
// The oracle walks every UTC minute with its own Intl formatter and applies the rules in words; it shares no code with
// slots.ts.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { slotsDue } from './slots.ts'
import { MIN, oracle, wall } from './test-oracle.ts'

const R = (o: { days_mask?: number; hour: number; minute: number }) => ({ id: 'rt_AAAAAAAAAAAAAAAAAAAAAA', days_mask: o.days_mask ?? 127, ...o })
const Z = (iso: string) => Date.parse(iso)

describe('literal DST fixtures (tests 2 and 3)', () => {
  const cases: [string, string, number, number, string, string][] = [
    // zone, local date, hour, minute, expected instant, why
    ['America/New_York', '2026-03-08', 2, 30, '2026-03-08T07:00:00Z', 'skipped: the next valid minute, 03:00 EDT'],
    ['America/New_York', '2026-11-01', 1, 30, '2026-11-01T05:30:00Z', 'repeated: the first, 01:30 EDT'],
    ['Europe/London', '2026-03-29', 1, 30, '2026-03-29T01:00:00Z', 'skipped: 02:00 BST'],
    ['Europe/London', '2026-10-25', 1, 30, '2026-10-25T00:30:00Z', 'repeated: the first, 01:30 BST'],
  ]
  for (const [tz, date, hour, minute, expected, why] of cases) {
    it(`${tz} ${date} ${hour}:${minute} → ${expected} (${why})`, () => {
      const from = Z(`${date}T00:00:00Z`) - 86_400_000
      const to = from + 3 * 86_400_000
      const hits = slotsDue(R({ hour, minute }), tz, from, to).filter(s => s.localDate === date)
      expect(hits).toEqual([{ key: `rt_AAAAAAAAAAAAAAAAAAAAAA|${date}|${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, localDate: date, localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, dueAtMs: Z(expected) }])
    })
  }

  it('the window is (from, to]: a slot due exactly at `from` is out, one due exactly at `to` is in', () => {
    const due = Z('2026-06-01T10:00:00Z') // 06:00 EDT
    expect(slotsDue(R({ hour: 6, minute: 0 }), 'America/New_York', due, due + 60_000)).toEqual([])
    expect(slotsDue(R({ hour: 6, minute: 0 }), 'America/New_York', due - 60_000, due).map(s => s.dueAtMs)).toEqual([due])
  })

  it('an unknown zone fails loud', () => {
    expect(() => slotsDue(R({ hour: 6, minute: 0 }), 'Mars/Olympus_Mons', 0, 86_400_000)).toThrow(RangeError)
  })
})

// ---------- the brute-force oracle (test 1) ----------

const ZONES = ['America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata', 'America/Santiago', 'America/Havana', 'Africa/Cairo'] as const
/** Every UTC hour of 2026 and 2027 where a zone's offset changes (found with the oracle's own clock), to aim windows at. */
function transitions(tz: string): number[] {
  const out: number[] = []
  const offset = (t: number) => Date.parse(`${wall(t, tz).replace(' ', 'T')}:00Z`) - t
  let prev = offset(Z('2026-01-01T00:00:00Z'))
  for (let t = Z('2026-01-01T01:00:00Z'); t < Z('2028-01-01T00:00:00Z'); t += 3_600_000) {
    const o = offset(t)
    if (o !== prev) out.push(t)
    prev = o
  }
  return out
}
const TRANSITIONS = new Map(ZONES.map(z => [z, transitions(z)]))

describe('slotsDue against a brute-force oracle (test 1)', () => {
  it('has transitions to aim at in every zone but Kolkata', () => {
    for (const z of ZONES) expect(TRANSITIONS.get(z)!.length > 0, z).toBe(z !== 'Asia/Kolkata')
  })

  it('equals the oracle for random zones, schedules and windows of up to 4 days in 2026 and 2027', () => {
    const window = fc.record({
      zone: fc.constantFrom(...ZONES),
      mask: fc.integer({ min: 1, max: 127 }),
      near: fc.boolean(),
      pick: fc.nat(),
      startMin: fc.integer({ min: 0, max: 2 * 365 * 1440 - 4 * 1440 }),
      jitterMin: fc.integer({ min: -2 * 1440, max: 2 * 1440 }),
      lengthMin: fc.integer({ min: 1, max: 4 * 1440 }),
      hour: fc.integer({ min: 0, max: 23 }),
      minute: fc.integer({ min: 0, max: 59 }),
      atTransition: fc.boolean(),
    })
    fc.assert(fc.property(window, w => {
      const ts = TRANSITIONS.get(w.zone)!
      const anchor = w.near && ts.length > 0 ? ts[w.pick % ts.length] + w.jitterMin * MIN : Z('2026-01-01T00:00:00Z') + w.startMin * MIN
      // Half the time, schedule at the local wall time just before the transition (the skipped or repeated hour).
      let hour = w.hour
      let minute = w.minute
      if (w.atTransition && w.near && ts.length > 0) {
        const t = wall(ts[w.pick % ts.length] - 15 * MIN, w.zone).slice(11)
        hour = Number(t.slice(0, 2))
        minute = (Number(t.slice(3, 5)) + w.minute % 45) % 60
      }
      const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      const from = Math.floor(anchor / MIN) * MIN
      const to = from + w.lengthMin * MIN
      const got = slotsDue(R({ days_mask: w.mask, hour, minute }), w.zone, from, to).map(s => ({ key: s.key, dueAtMs: s.dueAtMs }))
      expect(got).toEqual(oracle(w.zone, w.mask, hhmm, from, to))
    }), { numRuns: 60 })
  })
})
