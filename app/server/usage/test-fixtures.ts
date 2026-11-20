// Fixtures for the usage tests (server/usage/*.test.ts, in the Workers runtime). Never imported by the Worker.
import { env } from 'cloudflare:workers'

export const db = env.DB

/** A wall clock in November 2026 (Europe/London, GMT): every fixture turn lands in month `2026-11`. */
export const NOV = Date.UTC(2026, 10, 15, 12, 0, 0)
export const MONTH = '2026-11'

/** Stores a brand setting as the settings store would (`value_json` holds the JSON of the value). */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.prepare(`INSERT INTO settings (owner, key, value_json, rev, updated_at_ms, updated_by, req_id)
    VALUES ('brand', ?, ?, 1, 1, 'm_system', 'req-test') ON CONFLICT (owner, key) DO UPDATE SET value_json = excluded.value_json, rev = rev + 1`)
    .bind(key, JSON.stringify(value)).run()
}

/** No ledger rows, no settings; the zone `Europe/London` and the cap given (`null`: none). */
export async function resetUsage(cap: string | null, tz = 'Europe/London'): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM usage_extends'),
    db.prepare('DELETE FROM usage_turns'),
    db.prepare('DELETE FROM usage_months'),
    db.prepare('DELETE FROM settings'),
  ])
  await setSetting('g:tz', tz)
  if (cap !== null) await setSetting('s:cap', cap)
}

export interface MonthRow { cap_micro: number; reserved_micro: number; spent_micro: number; alert_crossed_at_ms: number | null }
export const monthRow = async (month = MONTH): Promise<MonthRow | null> =>
  db.prepare('SELECT cap_micro, reserved_micro, spent_micro, alert_crossed_at_ms FROM usage_months WHERE month = ?').bind(month).first<MonthRow>()

export interface TurnRow { reserved_micro: number; settled_micro: number; final: number; runner_cost_micro: number | null; month: string }
export const turnRow = async (turnId: string): Promise<TurnRow | null> =>
  db.prepare('SELECT reserved_micro, settled_micro, final, runner_cost_micro, month FROM usage_turns WHERE turn_id = ?').bind(turnId).first<TurnRow>()

/**
 * A D1 whose next batch commits and then throws (the reply was lost), when `loseNext()` was called before it. Every
 * other call goes to the real database.
 */
export function lossyDb(real: D1Database = db): { db: D1Database; loseNext: () => void; lost: () => number } {
  let lose = false
  let lost = 0
  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (stmts: D1PreparedStatement[]) => {
          const result = await target.batch(stmts)
          if (lose) {
            lose = false
            lost++
            throw new Error('fixture: the batch committed and its reply was lost')
          }
          return result
        }
      }
      const v = Reflect.get(target, prop, target) as unknown
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  return { db: wrapped, loseNext: () => { lose = true }, lost: () => lost }
}

/** A turn's reserve input on Sonnet 5.5 (ceiling $14.68) at `NOV`. */
export const turnIn = (turnId: string, o: Partial<{ model: string; chatId: string; memberId: string; nowMs: number }> = {}) => ({
  turnId, runId: `r_${turnId}`, chatId: o.chatId ?? `c_${turnId}`, memberId: o.memberId ?? 'm_ada', model: o.model ?? 'claude-sonnet-5-5', nowMs: o.nowMs ?? NOV,
})
