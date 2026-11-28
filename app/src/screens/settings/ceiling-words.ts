// What Settings > What the agent can do says about each operation (Stage 1 M3-C, N26), and the checks its Change window
// runs before it saves. Ceiling.tsx draws them. Plain words only: the page is technical, but a person reads it.
import type { CeilingRow, CeilingValues } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { CONFLICT, FORBIDDEN } from '../../../shared/contract/error-codes'
import { WRITES_OFF } from '../../../shared/contract/ceiling-codes'
import type { Guardrail } from '../../../shared/contract/permissions'
import { fmtCount, fmtMoney, majorOf, moneyOf } from '../../lib/format'
import { display } from '../../state/display'

const n = (v: number) => fmtCount(v, display())

/**
 * The bounds the server checks (shared/contract/ceiling.ts `LIMIT_MAX`, `BULK_THRESHOLD_MAX`, actions.ts
 * `BATCH_ITEMS_MAX`), as plain numbers: those files carry zod, which the Settings screen doesn't load. ceiling-words.test.ts
 * holds them equal.
 */
export const CEILING_BOUNDS = { limit: 1_000_000_000, bulkThreshold: 5, batch: 500 } as const

/**
 * `v` of the operation's units, as a person reads it: "1 order", "200 orders" (every count label is a plural ending in
 * "s"); a money operation's as money in the shop's currency ("$500"), its units being the currency's minor units
 * (#515). While no connected store names its currency the amount can't be shown as money, so it says what it counts.
 */
function amount(r: CeilingRow, v: number): string {
  if (r.measure.kind === 'count') return `${n(v)} ${v === 1 && r.measure.label.endsWith('s') ? r.measure.label.slice(0, -1) : r.measure.label}`
  if (r.measure.currency) return fmtMoney({ minor: v, currency: r.measure.currency }, display())
  return `${n(v)} in the smallest unit of the shop's currency`
}

/** The limits in force, one line each, only the ones that apply. Off: one line that says so. */
export function limitLines(r: CeilingRow): string[] {
  if (!r.enabled) return ["Off. Your Inhouse agent can't do this."]
  return [
    ...(r.applies.perDay ? [`Up to ${amount(r, r.perDayMax)} a day for each Always allow`] : []),
    `Up to ${amount(r, r.unitsMax)} in one go`,
    ...(r.applies.batch ? [`More than ${n(r.bulkThreshold)} at once needs an exact OK, and up to ${n(r.batchMax)} in one batch`] : []),
  ]
}

/**
 * The guardrails an operation's effects always apply (the row's `guardrails`), in words. `bulk` and `count` depend on the
 * call and `browser` has no operation, so the page never lists them. Stage 1 M4 (N46): `unreviewed`.
 */
export const GUARDRAIL_WORDS: Readonly<Record<Exclude<Guardrail, 'bulk' | 'count' | 'browser'>, string>> = {
  money: 'it moves money', customer: 'it reaches a customer', destructive: "it can't be undone", access: 'it changes who has access',
  unreviewed: "it isn't reviewed yet",
}

/** Who approves it and which guardrail applies, in one line. */
export function approvalLine(r: CeilingRow): string {
  const why = r.guardrails.map(g => (Object.hasOwn(GUARDRAIL_WORDS, g) ? GUARDRAIL_WORDS[g as keyof typeof GUARDRAIL_WORDS] : '')).filter(Boolean)
  const who = r.approverKind === 'admins' ? 'An admin approves it' : 'The person who asked approves it'
  if (why.length > 0) return `${who} exactly, every time, because ${why.join(' and ')}.`
  return `${who} first, or chooses Always allow.`
}

/** One field of the Change window: what it sets, its label, its bounds, how the stored value shows in it and reads back. */
export interface CeilingField {
  key: Exclude<keyof CeilingValues, 'enabled'>
  label: string
  /** The most it takes, as stored (a count, or minor currency units). */
  max: number
  /** The stored value as the field shows it (a money limit in the currency's major unit: "500" for $500.00). */
  shown: (v: number) => string
  /** The typed text as the value to store, or null when it isn't one (a money limit may have the currency's decimals). */
  read: (raw: string) => number | null
  /** What to type, for the error. */
  hint: string
  /** It takes decimals (money in a currency that has them): the phone keyboard offers a decimal point. */
  decimals: boolean
  /**
   * A money field's live reading of what's typed, in the store's currency format ("= KD 1,500.000"), so a person sees the
   * amount that will be saved before saving it; null while what's typed isn't an amount. Absent for a count.
   */
  preview?: (raw: string) => string | null
}

/**
 * Typed digits as plain digits: commas only as a well-formed thousands separator (groups of exactly three, before any
 * decimal point, the first group not starting with zero), so "500,50", "1,50" or "0,500" is never read as 50,050, 150
 * or 500. Null for anything else.
 */
export function plainNumber(raw: string): string | null {
  const t = raw.trim()
  return /^([1-9]\d{0,2}(,\d{3})+|\d+)(\.\d+)?$/.test(t) ? t.replace(/,/g, '') : null
}

const whole = (max: number) => ({
  shown: (v: number) => String(v),
  read: (raw: string) => (/^\d+$/.test(raw) ? Number(raw) : null),
  hint: `a whole number from 1 to ${n(max)}`,
  decimals: false,
})

/** A limit's field: a count as a whole number; money in its currency's major unit, with that currency's decimals at most. */
function limitField(r: CeilingRow, key: 'perDayMax' | 'unitsMax', what: string): CeilingField {
  const max = CEILING_BOUNDS.limit
  if (r.measure.kind === 'count') return { key, label: `Most ${r.measure.label} ${what}`, max, ...whole(max) }
  const currency = r.measure.currency
  if (!currency) return { key, label: `Most ${what}, in the smallest unit of the shop's currency`, max, ...whole(max) }
  const read = (raw: string) => {
    if (!/^\d+(\.\d+)?$/.test(raw)) return null
    const minor = moneyOf(Number(raw), currency).minor
    // More decimals than the currency has would be rounded: refused, so what's saved is what was typed.
    return String(majorOf({ minor, currency })) === String(Number(raw)) ? minor : null
  }
  return {
    key, label: `Most ${what} (${currency})`, max,
    shown: v => String(majorOf({ minor: v, currency })),
    read,
    preview: raw => {
      const plain = plainNumber(raw)
      const minor = plain === null ? null : read(plain)
      return minor === null || minor < 1 || minor > max ? null : `= ${fmtMoney({ minor, currency }, display(), { cents: 'always' })}`
    },
    hint: `an amount from ${fmtMoney({ minor: 1, currency }, display())} to ${fmtMoney({ minor: max, currency }, display())}`,
    decimals: majorOf({ minor: 1, currency }) < 1,
  }
}

/** The fields the Change window offers for this operation, with their bounds. */
export function fieldsOf(r: CeilingRow): CeilingField[] {
  return [
    ...(r.applies.perDay ? [limitField(r, 'perDayMax', 'a day for each Always allow')] : []),
    limitField(r, 'unitsMax', 'in one go'),
    ...(r.applies.batch ? [
      { key: 'bulkThreshold' as const, label: 'Exact OK when more than this at once', max: CEILING_BOUNDS.bulkThreshold, ...whole(CEILING_BOUNDS.bulkThreshold) },
      { key: 'batchMax' as const, label: 'Most in one batch', max: CEILING_BOUNDS.batch, ...whole(CEILING_BOUNDS.batch) },
    ] : []),
  ]
}

/** The typed values, or what's wrong with the first field that isn't a value in its bounds. */
export function readValues(r: CeilingRow, enabled: boolean, typed: Partial<Record<keyof CeilingValues, string>>): { ok: CeilingValues } | { error: string } {
  const out: CeilingValues = { enabled, perDayMax: r.perDayMax, unitsMax: r.unitsMax, bulkThreshold: r.bulkThreshold, batchMax: r.batchMax }
  for (const f of fieldsOf(r)) {
    const typedText = typed[f.key]
    const plain = typedText === undefined ? null : plainNumber(typedText)
    if (typedText !== undefined && /^[+-]/.test(typedText.trim())) return { error: `${f.label}: enter ${f.hint}, with no + or - sign.` }
    if (typedText !== undefined && plain === null && typedText.includes(',')) {
      return { error: `${f.label}: enter ${f.hint}. Use a comma only between thousands, as in 1,500.` }
    }
    const v = typedText === undefined ? r[f.key] : plain === null ? null : f.read(plain)
    if (v === null || !Number.isSafeInteger(v) || v < 1 || v > f.max) return { error: `${f.label}: enter ${f.hint}.` }
    out[f.key] = v
  }
  return { ok: out }
}

/** Whether `next` takes anything away from `prev`: switching off, or any smaller limit (N23: it ends every Always allow under it). */
export const lowers = (prev: CeilingValues, next: CeilingValues): boolean =>
  (prev.enabled && !next.enabled) || next.perDayMax < prev.perDayMax || next.unitsMax < prev.unitsMax || next.bulkThreshold < prev.bulkThreshold || next.batchMax < prev.batchMax

/** Whether `next` changes anything. */
export const changes = (prev: CeilingValues, next: CeilingValues): boolean =>
  (['enabled', 'perDayMax', 'unitsMax', 'bulkThreshold', 'batchMax'] as const).some(k => prev[k] !== next[k])

/** What a refused change says. A stale one shows the row as it is now. */
export function changeRefusal(e: unknown): string {
  if (e instanceof AgentError && e.code === CONFLICT) return 'Someone changed this first. It shows the latest now.'
  if (e instanceof AgentError && e.code === FORBIDDEN && e.reason === WRITES_OFF) return 'Changes are switched off in this build, so nothing changed.'
  if (e instanceof AgentError && e.code === FORBIDDEN) return 'Only the Inhouse team can change this.'
  return e instanceof AgentError ? e.message : 'Something went wrong. Try again.'
}
