// The routines signal (p4-w2.md section 11, Opus F4): red when routines stop deciding, a system routine missed its time,
// a run failed or was lost, a claimed row outlived its deadline, or an invariant alarm fired, in the last 24 hours. The
// detail names counts only. No rule reads `started` slots: one may wait on a question for days (section 6b).
import type { SignalResult } from '../ops/signals/types.ts'

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
        (SELECT COUNT(*) FROM routine_slots WHERE (state = 'ended' AND failure IS NOT NULL AND ended_at_ms >= ?)
          OR ((state = 'lost' OR (state = 'refused' AND reason = 'internal')) AND claimed_at_ms >= ?)) AS failed,
        (SELECT COUNT(*) FROM routine_slots WHERE state = 'claimed' AND deadline_ms < ?) AS overdue,
        (SELECT COUNT(*) FROM routine_alerts WHERE last_at_ms >= ?) AS alerts`,
  ).bind(nowMs - LAG_MS, since, since, since, nowMs, since).first<Record<'lagging' | 'system_missed' | 'failed' | 'overdue' | 'alerts', number>>()
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
