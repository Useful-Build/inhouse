// The routines signal (p4-w2.md section 11, Opus F4): red when routines stop deciding, a system routine missed its time,
// a run failed or was lost, a claimed row outlived its deadline, or an invariant alarm fired, in the last 24 hours. The
// detail names counts only. No rule reads `started` slots: one may wait on a question for days (section 6b).
import type { Signal, SignalResult } from '../ops/signals/types.ts'
import { BACKSTOP_MS } from './limits.ts'

const DAY = 86_400_000
/** A routine whose cursor lags `now` by more than this means the heartbeat stopped, or its pass throws. */
export const LAG_MS = 15 * 60_000

export async function routinesSignal(db: D1Database, nowMs: number): Promise<SignalResult> {
  const since = nowMs - DAY
  const r = await db.prepare(
    `SELECT
        (SELECT COUNT(*) FROM routines WHERE enabled = 1 AND deleted_at_ms IS NULL AND checked_until_ms < ?) AS lagging,
        (SELECT COUNT(*) FROM routine_slots s JOIN routines r ON r.id = s.routine_id
          WHERE r.origin = 'system' AND s.state = 'missed' AND s.claimed_at_ms >= ?) AS system_missed,
        (SELECT COUNT(*) FROM routine_slots WHERE
          -- W3's quiet case: a brand with no store connected ends every check not_connected; that isn't a failure here.
          (state = 'ended' AND failure IS NOT NULL AND failure <> 'not_connected' AND ended_at_ms >= ?)
          -- A backstop close happens 8 days after the start: counted from then, so it turns the signal red when it closes.
          OR (state = 'lost' AND reason = 'timeout' AND started_at_ms + ? >= ?)
          OR (((state = 'lost' AND reason IS NOT 'timeout') OR (state = 'refused' AND reason = 'internal')) AND claimed_at_ms >= ?)) AS failed,
        (SELECT COUNT(*) FROM routine_slots WHERE state = 'claimed' AND deadline_ms < ?) AS overdue,
        (SELECT COUNT(*) FROM routine_alerts WHERE last_at_ms >= ?) AS alerts`,
  ).bind(nowMs - LAG_MS, since, since, BACKSTOP_MS, since, since, nowMs, since).first<Record<'lagging' | 'system_missed' | 'failed' | 'overdue' | 'alerts', number>>()
  if (!r) throw new Error('routinesSignal: no row')
  const parts = [
    r.lagging > 0 ? `${r.lagging} behind` : '',
    r.system_missed > 0 ? `${r.system_missed} system missed` : '',
    r.failed > 0 ? `${r.failed} failed or lost` : '',
    r.overdue > 0 ? `${r.overdue} past deadline` : '',
    r.alerts > 0 ? `${r.alerts} alarms` : '',
  ].filter(Boolean)
  return parts.length === 0 ? { ok: true } : { ok: false, detail: parts.join(', ') }
}

/** The `routines` health signal over the request's stores. `now`: the health route's clock (signals get none of their own). */
export function routinesHealth(now: () => number = () => Date.now()): Signal {
  return { name: 'routines', check: ({ stores }) => stores.routines.signal(now()) }
}

export const routinesSignals: readonly Signal[] = [routinesHealth()]
