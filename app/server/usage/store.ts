// P3's `usage` store slot (p3-design sections 9 and 12): what route 42 (the Usage page) and the usage signal read, from
// D1 only. Every method takes data and returns data (the store contract in server/routes.ts). A month's numbers are
// read in one batch (one snapshot). Spend counts settled turns only: `conversations` = distinct chats with a settled
// turn (a routine run's chat is one too), `questionsAsked` = settled turns by people (a refused reserve leaves no turn
// row). Rows name people by member id, with the member's current name; no chat data (BD7). A routine's turn is a turn in
// a chat `m_system` owns: it counts toward `jobsRun` and the Job breakdown (by routine), never as a question or a person's
// row. A run is a chat (one chat per slot, server/routines/keys.ts): a run that parks on a question and resumes adds a
// second turn in the same chat, so runs count distinct chats while spend sums every turn. Spend by person plus spend by
// job is the month's total, and the spend by model is too.
import { SYSTEM_MEMBER_ID } from '../db/ids.ts'
import { runBatch, stmt } from '../db/sql.ts'
import { dayOf, daysIn, monthOf, zoneOf } from './month.ts'
import { ALERT_PCT_SQL, CAP_MICRO_SQL } from './settings-sql.ts'

export interface UsageGroupRow {
  key: string
  /** The member's current name (person rows); null for a model row or a member with none. */
  name: string | null
  micro: number
  conversations: number
  questions: number
}

/** One month's usage as stored, in micro-USD. */
export interface UsageMonthView {
  month: string
  current: boolean
  capMicro: number
  alertPct: number
  spentMicro: number
  conversations: number
  /** Settled turns by people (a routine's turns are `jobsRun`, not questions). */
  questions: number
  /** Distinct chats `m_system` owns with a settled turn: routine runs (a resumed run's second turn is the same run). */
  jobsRun: number
  /** Spend per day of the month in the brand's zone, day 1 first; up to today for the current month. */
  dailyMicro: number[]
  people: UsageGroupRow[]
  /** One row per routine: its spend, and its runs (distinct chats) in `questions` and `conversations`. */
  jobs: UsageGroupRow[]
  models: UsageGroupRow[]
  /** Months with a ledger row, newest first, the current one first. */
  months: string[]
}

/** What the `usage` store offers. */
export interface UsageStore {
  /** The month's view (`null`: this month in the brand's zone); null for a month after the current one. */
  month(q: { month: string | null; nowMs: number }): Promise<UsageMonthView | null>
  /** How many turns are still not final although they reserved before `beforeMs` (held budget nobody settled). */
  strandedTurns(q: { beforeMs: number }): Promise<number>
}

/**
 * A daily bucket: settled turns grouped by their reservation time in 15-minute slots (every zone offset is a multiple),
 * placed on days in today's `g:tz`. A turn's month was fixed at reservation, so after a zone change a turn near midnight
 * can sit on a neighbouring day (or outside this month's days, then it shows in the total only).
 */
const SLOT_MS = 15 * 60_000

export function usageStore(deps: { db: D1Database }): UsageStore {
  const { db } = deps
  return {
    async month({ month: asked, nowMs }) {
      const [settings] = await runBatch(db, [stmt(
        `SELECT (SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'g:tz' AND json_valid(value_json)) AS tz,
                ${CAP_MICRO_SQL} AS cap, ${ALERT_PCT_SQL} AS alert`,
      )])
      const s = (settings.results[0] ?? {}) as { tz: string | null; cap: number; alert: number }
      const tz = zoneOf(s.tz === null || s.tz === undefined ? null : JSON.parse(s.tz))
      const thisMonth = monthOf(nowMs, tz)
      const month = asked ?? thisMonth
      if (month > thisMonth) return null
      const current = month === thisMonth
      const settled = 'FROM usage_turns WHERE month = ? AND final = 1'
      const r = await runBatch(db, [
        stmt('SELECT cap_micro, spent_micro FROM usage_months WHERE month = ?', month),
        stmt(`SELECT COUNT(DISTINCT chat_id) AS conversations, COUNT(CASE WHEN member_id <> ? THEN 1 END) AS questions,
              COUNT(DISTINCT CASE WHEN member_id = ? THEN chat_id END) AS jobs ${settled}`, SYSTEM_MEMBER_ID, SYSTEM_MEMBER_ID, month),
        stmt(`SELECT created_at_ms / ${SLOT_MS} AS slot, SUM(settled_micro) AS micro ${settled} GROUP BY slot`, month),
        stmt(`SELECT t.member_id AS key, m.name AS name, SUM(t.settled_micro) AS micro, COUNT(DISTINCT t.chat_id) AS conversations, COUNT(*) AS questions
              FROM usage_turns t LEFT JOIN members m ON m.id = t.member_id WHERE t.month = ? AND t.final = 1 AND t.member_id <> ?
              GROUP BY t.member_id ORDER BY micro DESC, t.member_id`, month, SYSTEM_MEMBER_ID),
        stmt(`SELECT model AS key, NULL AS name, SUM(settled_micro) AS micro, COUNT(DISTINCT chat_id) AS conversations,
              COUNT(CASE WHEN member_id <> ? THEN 1 END) AS questions
              ${settled} GROUP BY model ORDER BY micro DESC, model`, SYSTEM_MEMBER_ID, month),
        // A refused reserve leaves an empty month row: only months with a turn or spend are offered.
        stmt(`SELECT month FROM usage_months m WHERE spent_micro > 0 OR EXISTS (SELECT 1 FROM usage_turns t WHERE t.month = m.month)
              ORDER BY month DESC LIMIT 24`),
        // A routine's turns, one row per routine; its runs are its distinct chats. The routine behind a chat is the slot whose
        // first turn (`routine_slots.turn_id`, unique-indexed) is one of the month's system turns, so no scan of the slots
        // table. A chat whose first turn is in another month, or whose slot was deleted after the steps retention period
        // (the turns outlive the slots), has no slot here: it is grouped under the empty key ("Other routines").
        stmt(`SELECT COALESCE(r.id, '') AS key, r.name AS name, SUM(t.settled_micro) AS micro, COUNT(DISTINCT t.chat_id) AS conversations,
              COUNT(DISTINCT t.chat_id) AS questions
              FROM usage_turns t
              LEFT JOIN (SELECT u.chat_id AS chat_id, MIN(s.routine_id) AS routine_id
                         FROM usage_turns u JOIN routine_slots s ON s.turn_id = u.turn_id
                         WHERE u.month = ? AND u.member_id = ? GROUP BY u.chat_id) c ON c.chat_id = t.chat_id
              LEFT JOIN routines r ON r.id = c.routine_id
              WHERE t.month = ? AND t.final = 1 AND t.member_id = ?
              GROUP BY COALESCE(r.id, '') ORDER BY micro DESC, key`, month, SYSTEM_MEMBER_ID, month, SYSTEM_MEMBER_ID),
      ])
      const row = r[0].results[0] as { cap_micro: number; spent_micro: number } | undefined
      const counts = r[1].results[0] as { conversations: number; questions: number; jobs: number }
      const days = current ? dayOf(nowMs, tz) : daysIn(month)
      const dailyMicro = Array.from({ length: days }, () => 0)
      for (const b of r[2].results as { slot: number; micro: number }[]) {
        const day = dayOf(b.slot * SLOT_MS, tz)
        if (day <= days) dailyMicro[day - 1] += b.micro
      }
      const months = [thisMonth, ...(r[5].results as { month: string }[]).map(m => m.month).filter(m => m !== thisMonth && m < thisMonth)]
      return {
        month, current,
        // This month: the cap as Settings holds it now. A finished month: the cap its ledger last recorded.
        capMicro: current ? s.cap : row?.cap_micro ?? 0,
        alertPct: s.alert,
        spentMicro: row?.spent_micro ?? 0,
        conversations: counts.conversations,
        questions: counts.questions,
        jobsRun: counts.jobs,
        dailyMicro,
        people: r[3].results as unknown as UsageGroupRow[],
        jobs: r[6].results as unknown as UsageGroupRow[],
        models: r[4].results as unknown as UsageGroupRow[],
        months,
      }
    },

    async strandedTurns({ beforeMs }) {
      const [r] = await runBatch(db, [stmt('SELECT COUNT(*) AS n FROM usage_turns WHERE final = 0 AND created_at_ms < ?', beforeMs)])
      return (r.results[0] as { n: number }).n
    },
  }
}
