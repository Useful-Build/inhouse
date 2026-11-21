// The fixed words of a morning-check slot's summary (`routine_slots.result_text`), and how Today reads them back. Today
// has no column for the run's gaps, and a result with no items has no row to hold them, so the summary carries them in
// words from a closed list; the reader parses only those words (never a model's text: no model word reaches the summary).
import { GAP_AREAS, ITEMS_MAX } from '../../shared/contract/today.ts'

export const thingsWords = (n: number): string => `found ${n === 0 ? '0 things' : n === 1 ? '1 thing' : `${n} things`}`

/** `found 3 things; couldn't read refunds, returns`, or `found more than 10 things; showing 10` for an overflow. */
export function incompleteSummary(items: number, gaps: readonly string[]): string {
  const tooMany = gaps.includes('too_many')
  const areas = GAP_AREAS.filter(a => gaps.includes(a))
  return [
    tooMany ? `found more than ${ITEMS_MAX} things; showing ${ITEMS_MAX}` : thingsWords(items),
    ...(areas.length > 0 ? [`couldn't read ${areas.join(', ')}`] : []),
  ].join('; ')
}

/** The areas and the overflow an `incompleteSummary` names. */
export function gapsOfSummary(text: string | null): { areas: (typeof GAP_AREAS)[number][]; tooMany: boolean } {
  const t = text ?? ''
  const read = /couldn't read ([a-z, ]+)/.exec(t)?.[1] ?? ''
  const named = read.split(', ')
  return { areas: GAP_AREAS.filter(a => named.includes(a)), tooMany: t.includes(`more than ${ITEMS_MAX} things`) }
}
