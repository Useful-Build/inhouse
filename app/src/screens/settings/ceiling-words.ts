// What Settings > What the agent can do says about each operation (Stage 1 M3-C, N26), and the checks its Change window
// runs before it saves. Ceiling.tsx draws them. Plain words only: the page is technical, but a person reads it.
import type { CeilingRow, CeilingValues } from '../../agent/types'
import { AgentError } from '../../agent/types'
import { CONFLICT, FORBIDDEN, WRITES_OFF } from '../../../shared/contract/error-codes'
import { fmtCount } from '../../lib/format'
import { display } from '../../state/display'

const n = (v: number) => fmtCount(v, display())

/**
 * The bounds the server checks (shared/contract/ceiling.ts `LIMIT_MAX`, `BULK_THRESHOLD_MAX`, actions.ts
 * `BATCH_ITEMS_MAX`), as plain numbers: those files carry zod, which the Settings screen doesn't load. ceiling-words.test.ts
 * holds them equal.
 */
export const CEILING_BOUNDS = { limit: 1_000_000_000, bulkThreshold: 5, batch: 500 } as const

/** What one of the operation's units is called: "orders", or the shop's currency for a money operation. */
const unitsOf = (r: CeilingRow): string =>
  r.measure.kind === 'count' ? r.measure.label : `minor units of ${r.measure.currency ?? "the shop's currency"}`

/** `v` of the unit: "1 order", "200 orders" (every count label is a plural ending in "s"). */
const count = (v: number, u: string) => `${n(v)} ${v === 1 && u.endsWith('s') ? u.slice(0, -1) : u}`

/** The limits in force, one line each, only the ones that apply. Off: one line that says so. */
export function limitLines(r: CeilingRow): string[] {
  if (!r.enabled) return ["Off. Your Inhouse agent can't do this."]
  const u = unitsOf(r)
  return [
    ...(r.applies.perDay ? [`Up to ${count(r.perDayMax, u)} a day for each Always allow`] : []),
    `Up to ${count(r.unitsMax, u)} in one go`,
    ...(r.applies.batch ? [`More than ${n(r.bulkThreshold)} at once needs an exact OK, and up to ${n(r.batchMax)} in one batch`] : []),
  ]
}

const GUARDRAIL_WORDS: Record<string, string> = { money: 'it moves money', customer: 'it reaches a customer', destructive: "it can't be undone", access: 'it changes who has access' }

/** Who approves it and which guardrail applies, in one line. */
export function approvalLine(r: CeilingRow): string {
  const why = r.guardrails.map(g => GUARDRAIL_WORDS[g]).filter(Boolean)
  const who = r.approverKind === 'admins' ? 'An admin approves it' : 'The person who asked approves it'
  if (why.length > 0) return `${who} exactly, every time, because ${why.join(' and ')}.`
  return `${who} first, or chooses Always allow.`
}

/** The fields the Change window offers for this operation, with their bounds. */
export function fieldsOf(r: CeilingRow): { key: Exclude<keyof CeilingValues, 'enabled'>; label: string; max: number }[] {
  const u = unitsOf(r)
  return [
    ...(r.applies.perDay ? [{ key: 'perDayMax' as const, label: `Most ${u} a day for each Always allow`, max: CEILING_BOUNDS.limit }] : []),
    { key: 'unitsMax' as const, label: `Most ${u} in one go`, max: CEILING_BOUNDS.limit },
    ...(r.applies.batch ? [
      { key: 'bulkThreshold' as const, label: 'Exact OK when more than this at once', max: CEILING_BOUNDS.bulkThreshold },
      { key: 'batchMax' as const, label: 'Most in one batch', max: CEILING_BOUNDS.batch },
    ] : []),
  ]
}

/** The typed values, or what's wrong with the first field that isn't a whole number in its bounds. */
export function readValues(r: CeilingRow, enabled: boolean, typed: Partial<Record<keyof CeilingValues, string>>): { ok: CeilingValues } | { error: string } {
  const out: CeilingValues = { enabled, perDayMax: r.perDayMax, unitsMax: r.unitsMax, bulkThreshold: r.bulkThreshold, batchMax: r.batchMax }
  for (const f of fieldsOf(r)) {
    const raw = (typed[f.key] ?? String(r[f.key])).trim().replace(/,/g, '')
    const v = /^\d+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isSafeInteger(v) || v < 1 || v > f.max) return { error: `${f.label}: enter a whole number from 1 to ${n(f.max)}.` }
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
