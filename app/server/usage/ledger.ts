// The usage ledger (p3-design section 9 and 12, `UsageLedgerPort`): the brand's monthly cap, every turn's hold and its
// settled cost, in micro-USD integers on D1. Every write is ONE `DB.batch` (one transaction, statements in order, all
// rolled back if one fails: https://developers.cloudflare.com/d1/worker-api/d1-database/, read 2026-11-20) whose first
// conditional UPDATE puts a fresh `stamp` on the month row; the batch's later statements act only where that stamp is
// (`EXISTS ... stamp = ?`), so a write whose guard refused changes nothing else. Each method is idempotent, so the
// BrandAgent retries one whose reply was lost (the batch committed, the answer never arrived) and gets the same result:
// - `reserve` by turn id (`NOT EXISTS` the turn row), answered from the turn row whatever call made it;
// - `extend` by `(turnId, callId)` (the `usage_extends` row a granted extend writes);
// - `close` by that row's `closed` flag, and a no-op once the turn is final;
// - `settle` and `release` by `final = 0`.
// The cap is read from `settings` inside the reserve and extend batches (settings-sql.ts), so a lowered cap refuses at
// once and a raised one clears. Settle books the egress tally only: the runner's `costUsd` is an SDK estimate that
// counts a resumed session's earlier spend (Agent SDK cost tracking, read 2026-11-20:
// https://code.claude.com/docs/en/agent-sdk/cost-tracking), so it's stored beside the bill, never added.
import { StoreUnavailableError } from '../db/sql.ts'
import type { ReserveInput, UsageLedgerPort } from '../do/brand-agent/ports.ts'
import { TURN_CEILING_MICRO } from '../model/catalog.ts'
import { monthOf, zoneOf } from './month.ts'
import { ALERT_PCT_SQL, CAP_MICRO_SQL } from './settings-sql.ts'

/** The start hold every turn reserves (the cap gate): $0.25. */
export const START_HOLD_MICRO = 250_000
/** An extend's need is rounded up to this: $0.05. */
export const EXTEND_UNIT_MICRO = 50_000

export type ExtendAnswer = Awaited<ReturnType<UsageLedgerPort['extend']>>

/** The real ledger: the port, plus the runner's cost on `settle` (stored for comparison only). */
export interface UsageLedger extends UsageLedgerPort {
  /** `runnerCostMicro`: the runner's `costUsd` in micro-USD, kept in `runner_cost_micro`, never added to spend. */
  settle(turnId: string, micro: number, nowMs: number, runnerCostMicro?: number | null): Promise<void>
}

export interface LedgerDeps {
  db: D1Database
  /** Stamps `usage_extends.at_ms` (extend and close take no time). */
  now?: () => number
  /** A fresh batch stamp; random by default. */
  stamp?: () => string
}

type Val = string | number | null
type Q = { sql: string; params: Val[] }
const q = (sql: string, ...params: Val[]): Q => ({ sql, params })

/** The model's ceiling as SQL over `usage_turns.model` (NULL for a model with none, so its extends never pass). */
const CEILING_SQL = `(CASE model ${Object.entries(TURN_CEILING_MICRO).map(([m, c]) => `WHEN '${m.replaceAll("'", "''")}' THEN ${c}`).join(' ')} END)`

const amount = (what: string, v: number) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`usage: ${what} must be a non-negative integer of micro-USD, got ${v}`)
  return v
}
const id = (what: string, v: string) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) throw new Error(`usage: bad ${what}`)
  return v
}

export function createUsageLedger(deps: LedgerDeps): UsageLedger {
  const { db } = deps
  const now = deps.now ?? (() => Date.now())
  const stamp = deps.stamp ?? (() => crypto.randomUUID())

  const batch = async (qs: Q[]): Promise<D1Result[]> => {
    try {
      return await db.batch(qs.map(s => db.prepare(s.sql).bind(...s.params)))
    } catch (err) {
      throw new StoreUnavailableError('usage ledger', err)
    }
  }
  const row = <T>(r: D1Result | undefined): T | null => ((r?.results ?? [])[0] as T | undefined) ?? null

  const tzNow = async (): Promise<string> => {
    let value: unknown = null
    try {
      const r = await db.prepare("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'g:tz'").first<{ value_json: string }>()
      value = r ? JSON.parse(r.value_json) : null
    } catch (err) {
      throw new StoreUnavailableError('usage ledger', err)
    }
    return zoneOf(value)
  }

  /** Settle's batch: books `microSql` (bound with `microParams`) once, at `final = 0`, and records the first alert crossing. */
  const finalize = async (turnId: string, microSql: string, microParams: Val[], nowMs: number, runnerCost: number | null) => {
    const s = stamp()
    await batch([
      q(`UPDATE usage_months SET spent_micro = spent_micro + ${microSql},
           reserved_micro = reserved_micro - (SELECT reserved_micro FROM usage_turns WHERE turn_id = ?), stamp = ?
         WHERE month = (SELECT month FROM usage_turns WHERE turn_id = ? AND final = 0)`, ...microParams, turnId, s, turnId),
      q(`UPDATE usage_turns SET settled_micro = ${microSql}, final = 1, source = 'tally', settled_at_ms = ?, runner_cost_micro = ?, stamp = ?
         WHERE turn_id = ? AND final = 0 AND EXISTS (SELECT 1 FROM usage_months WHERE stamp = ?)`, ...microParams, nowMs, runnerCost, s, turnId, s),
      q(`UPDATE usage_months SET alert_crossed_at_ms = ?
         WHERE stamp = ? AND alert_crossed_at_ms IS NULL AND cap_micro > 0 AND spent_micro * 100 >= cap_micro * ${ALERT_PCT_SQL}`, nowMs, s),
    ])
  }

  return {
    async reserve(t: ReserveInput) {
      const turnId = id('turn id', t.turnId)
      // route 29 only lets catalogue models through; a model with no ceiling could never extend, so refuse it loudly.
      if (TURN_CEILING_MICRO[t.model] === undefined) throw new Error(`usage: no per-turn ceiling for model ${t.model}`)
      const month = monthOf(t.nowMs, await tzNow())
      const s = stamp()
      const r = await batch([
        // (1) The month row, its cap refreshed from settings in this transaction.
        q(`INSERT INTO usage_months (month, cap_micro) VALUES (?, ${CAP_MICRO_SQL})
           ON CONFLICT (month) DO UPDATE SET cap_micro = excluded.cap_micro`, month),
        // (2) The hold, only if it fits under the cap and the turn holds nothing yet.
        q(`UPDATE usage_months SET last_reserve_micro = ?, reserved_micro = reserved_micro + ?, stamp = ?
           WHERE month = ? AND cap_micro - spent_micro - reserved_micro >= ?
             AND NOT EXISTS (SELECT 1 FROM usage_turns WHERE turn_id = ?)`,
          START_HOLD_MICRO, START_HOLD_MICRO, s, month, START_HOLD_MICRO, turnId),
        // (3) The turn row, only under this batch's stamp.
        q(`INSERT INTO usage_turns (turn_id, run_id, chat_id, member_id, model, month, reserved_micro, created_at_ms, stamp)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM usage_months WHERE month = ? AND stamp = ?)`,
          turnId, id('run id', t.runId), id('chat id', t.chatId), id('member id', t.memberId), t.model, month, START_HOLD_MICRO, t.nowMs, s, month, s),
        q('SELECT reserved_micro FROM usage_turns WHERE turn_id = ?', turnId),
        q('SELECT cap_micro, spent_micro FROM usage_months WHERE month = ?', month),
      ])
      const turn = row<{ reserved_micro: number }>(r[3])
      if (turn) return { reservedMicro: turn.reserved_micro }
      const m = row<{ cap_micro: number; spent_micro: number }>(r[4])
      if (!m) throw new Error('usage: the month row is missing after its upsert')
      // Refused: `cap_reached` when the start hold can't fit even with no other hold; else others' holds (`budget_busy`).
      return { refused: m.cap_micro - m.spent_micro < START_HOLD_MICRO ? 'cap_reached' as const : 'budget_busy' as const }
    },

    async extend(turnIdIn, callIdIn, needIn): Promise<ExtendAnswer> {
      const turnId = id('turn id', turnIdIn)
      const callId = id('call id', callIdIn)
      if (amount('need', needIn) === 0) throw new Error('usage: an extend needs a positive amount')
      const need = Math.ceil(needIn / EXTEND_UNIT_MICRO) * EXTEND_UNIT_MICRO
      const s = stamp()
      const r = await batch([
        q(`UPDATE usage_months SET cap_micro = ${CAP_MICRO_SQL} WHERE month = (SELECT month FROM usage_turns WHERE turn_id = ?)`, turnId),
        q(`UPDATE usage_months SET reserved_micro = reserved_micro + ?, stamp = ?
           WHERE month = (SELECT month FROM usage_turns WHERE turn_id = ? AND final = 0)
             AND cap_micro - spent_micro - reserved_micro >= ?
             AND (SELECT reserved_micro + ? <= ${CEILING_SQL} FROM usage_turns WHERE turn_id = ?)
             AND NOT EXISTS (SELECT 1 FROM usage_extends WHERE turn_id = ? AND call_id = ?)`,
          need, s, turnId, need, need, turnId, turnId, callId),
        q(`UPDATE usage_turns SET reserved_micro = reserved_micro + ?, stamp = ?
           WHERE turn_id = ? AND EXISTS (SELECT 1 FROM usage_months WHERE stamp = ?)`, need, s, turnId, s),
        q(`INSERT INTO usage_extends (turn_id, call_id, need_micro, at_ms)
           SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM usage_months WHERE stamp = ?)`, turnId, callId, need, now(), s),
        q(`SELECT t.reserved_micro, t.final, ${CEILING_SQL} AS ceiling, m.cap_micro, m.spent_micro,
             EXISTS (SELECT 1 FROM usage_extends e WHERE e.turn_id = t.turn_id AND e.call_id = ?) AS granted
           FROM usage_turns t JOIN usage_months m ON m.month = t.month WHERE t.turn_id = ?`, callId, turnId),
      ])
      const t = row<{ reserved_micro: number; final: number; ceiling: number | null; cap_micro: number; spent_micro: number; granted: number }>(r[4])
      if (!t) throw new Error('usage: extend for a turn that holds nothing')
      const ledgerHold = t.final ? 0 : t.reserved_micro
      if (t.granted) return { ok: true, ledgerHold }
      // A final turn takes no more money: answered as its budget being spent.
      if (t.final) return { refused: 'turn_budget', ledgerHold }
      if (t.cap_micro - t.spent_micro < need) return { refused: 'cap_reached', ledgerHold }
      if (t.ceiling === null || t.reserved_micro + need > t.ceiling) return { refused: 'turn_budget', ledgerHold }
      return { refused: 'held', ledgerHold }
    },

    async close(turnIdIn, callIdIn, actualIn, holdIn) {
      const turnId = id('turn id', turnIdIn)
      const callId = id('call id', callIdIn)
      const actual = amount('actual', actualIn)
      const hold = amount('hold', holdIn)
      const s = stamp()
      // The hold only ever shrinks here: a close never raises a turn's money past what a cap-checked extend granted.
      const r = await batch([
        q('SELECT reserved_micro FROM usage_turns WHERE turn_id = ?', turnId),
        q(`UPDATE usage_months SET reserved_micro = reserved_micro + (SELECT MIN(?, reserved_micro) - reserved_micro FROM usage_turns WHERE turn_id = ?), stamp = ?
           WHERE month = (SELECT month FROM usage_turns WHERE turn_id = ? AND final = 0)
             AND NOT EXISTS (SELECT 1 FROM usage_extends WHERE turn_id = ? AND call_id = ? AND closed = 1)`,
          hold, turnId, s, turnId, turnId, callId),
        q(`UPDATE usage_turns SET reserved_micro = MIN(?, reserved_micro), stamp = ?
           WHERE turn_id = ? AND EXISTS (SELECT 1 FROM usage_months WHERE stamp = ?)`, hold, s, turnId, s),
        q(`INSERT INTO usage_extends (turn_id, call_id, need_micro, actual_micro, closed, at_ms)
           SELECT ?, ?, 0, ?, 1, ? WHERE EXISTS (SELECT 1 FROM usage_months WHERE stamp = ?)
           ON CONFLICT (turn_id, call_id) DO UPDATE SET actual_micro = excluded.actual_micro, closed = 1`, turnId, callId, actual, now(), s),
        q('SELECT reserved_micro, final FROM usage_turns WHERE turn_id = ?', turnId),
      ])
      const before = row<{ reserved_micro: number }>(r[0])
      const t = row<{ reserved_micro: number; final: number }>(r[4])
      if (!t || !before) throw new Error('usage: close for a turn that holds nothing')
      if ((r[1]?.meta.changes ?? 0) > 0 && hold > before.reserved_micro) {
        console.warn({ event: 'usage_close_hold_above_ledger', turnId, holdMicro: hold, ledgerHold: before.reserved_micro })
      }
      return { ledgerHold: t.final ? 0 : t.reserved_micro }
    },

    async settle(turnIdIn, micro, nowMs, runnerCostMicro = null) {
      const turnId = id('turn id', turnIdIn)
      amount('settled cost', micro)
      if (runnerCostMicro !== null) amount('runner cost', runnerCostMicro)
      const known = await db.prepare('SELECT 1 AS one FROM usage_turns WHERE turn_id = ?').bind(turnId).first().catch((err: unknown) => {
        throw new StoreUnavailableError('usage ledger', err)
      })
      if (!known) {
        // A turn whose reserve was refused (or never made) holds nothing; booking a cost for it would lose that cost.
        if (micro > 0) throw new Error('usage: settle with a cost for a turn that holds nothing')
        return
      }
      await finalize(turnId, '?', [micro], nowMs, runnerCostMicro)
    },

    async release(turnIdIn, nowMs) {
      const turnId = id('turn id', turnIdIn)
      // Settle with what the tally holds: the closed calls' actual costs (none for a turn cancelled before any call).
      await finalize(turnId, '(SELECT COALESCE(SUM(actual_micro), 0) FROM usage_extends WHERE turn_id = ? AND closed = 1)', [turnId], nowMs, null)
    },
  }
}
