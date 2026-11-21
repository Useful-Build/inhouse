// The morning check's result, normalised then checked (p4-w3.md section 3, step 2). The SDK checks only the reduced wire
// schema, so cosmetic overruns are fixed here and counted, never failed; a structural error is `invalid_result`.
import { GAP_AREAS, ITEMS_MAX, MorningCheckResultSchema, TOO_MANY } from '../../shared/contract/today.ts'
import type { MorningCheckResult } from '../../shared/contract/today.ts'

export interface Normalised {
  /** Strings cut to their maximum (ending `…`). */
  truncated: number
  /** `found` rows that aren't a pair, and `found` and `sources` past their maxima. */
  dropped: number
  /** Items whose `key` repeated an earlier item's. */
  deduped: number
  /** Items past the tenth. */
  overflow: number
}

/** The gaps a stored result may name: the five areas and the server's `too_many`. */
export type StoredGap = (typeof GAP_AREAS)[number] | typeof TOO_MANY

export type Checked =
  | { ok: { result: Omit<MorningCheckResult, 'gaps'> & { gaps: StoredGap[] }; counts: Normalised } }
  | { invalid: true }

/** Item strings that may be cut (`key` may not: a cut key breaks its pattern, so it stays and fails). */
const ITEM_MAX = { title: 120, sub: 200, costNote: 100, next: 140, since: 40 } as const
const CELL_MAX = 160

/** `s` cut to `max` characters, the last of them `…` (a surrogate pair is never split). */
export function cut(s: string, max: number): string {
  if (s.length <= max) return s
  let head = s.slice(0, max - 1)
  const last = head.charCodeAt(head.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1)
  return `${head}…`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function normaliseResult(raw: unknown, brandCurrency: string): Checked {
  if (!isObject(raw)) return { invalid: true }
  const counts: Normalised = { truncated: 0, dropped: 0, deduped: 0, overflow: 0 }
  const fit = (v: unknown, max: number): unknown => {
    if (typeof v !== 'string' || v.length <= max) return v
    counts.truncated++
    return cut(v, max)
  }
  let items: unknown = raw.items
  if (Array.isArray(items)) {
    const seen = new Set<unknown>()
    const kept: unknown[] = []
    for (const it of items) {
      if (!isObject(it)) {
        kept.push(it)
        continue
      }
      if (typeof it.key === 'string' && seen.has(it.key)) {
        counts.deduped++
        continue
      }
      if (typeof it.key === 'string') seen.add(it.key)
      const next: Record<string, unknown> = { ...it }
      for (const [field, max] of Object.entries(ITEM_MAX)) if (field in next) next[field] = fit(next[field], max)
      if (Array.isArray(it.found)) {
        const rows = it.found.filter(r => Array.isArray(r) && r.length === 2 && r.every(c => typeof c === 'string'))
        counts.dropped += it.found.length - rows.length
        const kept6 = rows.slice(0, 6)
        counts.dropped += rows.length - kept6.length
        next.found = kept6.map(r => (r as string[]).map(c => fit(c, CELL_MAX)))
      }
      if (Array.isArray(it.sources)) {
        const kept10 = it.sources.slice(0, 10)
        counts.dropped += it.sources.length - kept10.length
        next.sources = kept10.map(s => (isObject(s) ? { ...s, ...('n' in s ? { n: fit(s.n, 40) } : {}), ...('text' in s ? { text: fit(s.text, CELL_MAX) } : {}) } : s))
      }
      kept.push(next)
    }
    if (kept.length > ITEMS_MAX) {
      counts.overflow = kept.length - ITEMS_MAX
      kept.length = ITEMS_MAX
    }
    items = kept
  }
  const parsed = MorningCheckResultSchema.safeParse({ ...raw, items })
  if (!parsed.success) return { invalid: true }
  const result = parsed.data
  // The brand shows one currency (`s:currency`): an item in another is a wrong value, not a cosmetic one.
  if (result.items.some(i => i.cost !== null && i.cost.currency !== brandCurrency)) return { invalid: true }
  if (counts.overflow === 0) return { ok: { result, counts } }
  return { ok: { result: { ...result, coverage: 'incomplete', gaps: [...result.gaps, TOO_MANY] }, counts } }
}
