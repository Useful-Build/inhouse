// Which run Today shows, and which status cards it adds (p4-w3.md section 5). Pure: the slots and the clock come in, so
// the literal timelines in the tests are the whole oracle. "Newer" is `(local_date, claimed_at_ms)` as a pair, never the
// slot key's text; Today shows the shown run's items only, so a late older result can't bring a resolved problem back.
import { ON_TIME_MS } from '../routines/limits.ts'
import { instantOf, intlZone, weekdayBit } from '../routines/slots.ts'
import { gapsOfSummary } from './words.ts'
import type { CardCause } from './ids.ts'

export interface SlotFacts {
  slot_key: string
  local_date: string
  local_time: string | null
  state: 'claimed' | 'started' | 'ended' | 'lost' | 'missed' | 'skipped' | 'refused'
  reason: string | null
  failure: string | null
  result_text: string | null
  claimed_at_ms: number
  ended_at_ms: number | null
}

export interface RoutineFacts {
  id: string
  enabled: boolean
  deleted: boolean
  days_mask: number
  hour: number
  minute: number
}

export interface Card {
  cause: CardCause
  localDate: string
  /** What the id hashes: the slot's key, or `<routineId>|<local date>` for `not_run` and `off`. */
  hashed: string
  /** The clock the card names ("6:00 AM"), when it names one. */
  clock: string | null
  /** The instant shown as the card's time. */
  atMs: number
  /** `incomplete` only: the areas the run couldn't read, and whether it found more than the cap. */
  areas: string[]
  tooMany: boolean
}

export interface View {
  shown: SlotFacts | null
  cards: Card[]
}

/** Newest first by (local_date, claimed_at_ms). */
export const byNewest = (a: SlotFacts, b: SlotFacts): number => (a.local_date === b.local_date ? b.claimed_at_ms - a.claimed_at_ms : a.local_date < b.local_date ? 1 : -1)

const pad = (n: number) => String(n).padStart(2, '0')
/** `06:00` as "6:00 AM". */
export function clockWords(time: string): string {
  const h = Number(time.slice(0, 2))
  return `${h % 12 === 0 ? 12 : h % 12}:${time.slice(3, 5)} ${h < 12 ? 'AM' : 'PM'}`
}

export function todayView(input: { nowMs: number; tz: string; routine: RoutineFacts | null; slots: readonly SlotFacts[] }): View {
  const zone = intlZone(input.tz)
  const today = zone(input.nowMs).date
  const slots = [...input.slots].sort(byNewest)
  const valid = (s: SlotFacts) => s.state === 'ended' && (s.failure === null || s.failure === 'incomplete')
  const shown = slots.find(valid) ?? null
  const clockOf = (s: SlotFacts) => clockWords(s.local_time ?? zone(s.ended_at_ms ?? s.claimed_at_ms).time)
  const atOf = (s: SlotFacts) => s.ended_at_ms ?? s.claimed_at_ms
  const cards: Card[] = []
  const slotCard = (cause: CardCause, s: SlotFacts, extra: Partial<Card> = {}): Card =>
    ({ cause, localDate: s.local_date, hashed: s.slot_key, clock: clockOf(s), atMs: atOf(s), areas: [], tooMany: false, ...extra })

  if (shown !== null && shown.failure === 'incomplete') {
    const g = gapsOfSummary(shown.result_text)
    cards.push(slotCard('incomplete', shown, { areas: g.areas, tooMany: g.tooMany }))
  }
  const newest = slots.find(s => s.local_date === today)
  if (newest) {
    if (newest.state === 'ended') {
      if (newest.failure === 'not_connected') cards.push(slotCard('not_connected', newest))
      else if (newest.failure !== null && newest.failure !== 'incomplete') cards.push(slotCard('failed', newest))
    } else if (newest.state === 'lost' || newest.state === 'missed' || newest.state === 'refused') {
      cards.push(slotCard('failed', newest))
    } else if (newest.state === 'skipped') {
      cards.push(newest.reason === 'disabled' || newest.reason === 'deleted' ? slotCard('off', newest, { hashed: `${input.routine?.id ?? ''}|${today}` }) : slotCard('failed', newest))
    }
    return { shown, cards }
  }
  // No slot today: past the slot's deadline the check hasn't run (or is off).
  const r = input.routine
  if (r !== null && (r.days_mask & (1 << weekdayBit(today))) !== 0) {
    const due = instantOf(zone, today, `${pad(r.hour)}:${pad(r.minute)}`)
    if (input.nowMs > due + ON_TIME_MS) {
      cards.push({ cause: !r.enabled || r.deleted ? 'off' : 'not_run', localDate: today, hashed: `${r.id}|${today}`, clock: null, atMs: due + ON_TIME_MS, areas: [], tooMany: false })
    }
  }
  return { shown, cards }
}
