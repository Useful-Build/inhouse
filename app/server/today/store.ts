// The `today` store slot (p4-w3.md section 5): Today's read (route 57) and the set-aside write (route 58). Every method
// takes data and returns data (the store contract in server/routes.ts). Reads parse each stored item again
// (`TodayItemSchema`) and fail loud on a row that doesn't parse.
import type { Problem } from '../../shared/contract/problem.ts'
import { TodayItemSchema } from '../../shared/contract/today.ts'
import type { TodayAside, TodayItem } from '../../shared/contract/today.ts'
import { recordActivity } from '../activity/store.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditHook } from '../db/audit.ts'
import { writeStamp } from '../db/ids.ts'
import type { At, Outcome } from '../db/members.ts'
import { all, first, storage, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import { DEFAULT_TZ } from '../usage/month.ts'
import { intlZone } from '../routines/slots.ts'
import { brandCurrency } from './result.ts'
import { cardId } from './ids.ts'
import { cardProblem, toProblem } from './problem.ts'
import { todayView } from './view.ts'
import type { RoutineFacts, SlotFacts } from './view.ts'

export const MORNING_CHECK_ROUTINE = 'routine-morning-check'

/** The brand's zone (`g:tz`; unset or reset is the default). A value this runtime doesn't know throws: Today never guesses a day. */
async function brandZone(db: D1Database): Promise<string> {
  const row = await first<{ value_json: string }>(db, stmt("SELECT value_json FROM settings WHERE owner = 'brand' AND key = 'g:tz'"))
  const value: unknown = row ? JSON.parse(row.value_json) : null
  const tz = typeof value === 'string' ? value : DEFAULT_TZ
  intlZone(tz) // throws RangeError for a zone the runtime doesn't know
  return tz
}

interface AsideRow {
  item_id: string
  reason: 'snoozed' | 'dismissed' | 'declined' | null
  by: string
  at_ms: number
  rev: number
}

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })
const record = (r: AsideRow): TodayAside => ({ reason: r.reason, at: instant(r.at_ms), by: r.by, loggedAt: instant(r.at_ms), rev: r.rev })
const DAY = 86_400_000
const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - DAY).toISOString().slice(0, 10)

/** Whether a record hides its item now: a snooze until the brand's next local day after `at`, a dismissal for good (`declined` is P6's: hidden too). */
export function hides(r: Pick<AsideRow, 'reason' | 'at_ms'>, nowMs: number, zone: (ms: number) => { date: string }): boolean {
  if (r.reason === null) return false
  if (r.reason === 'snoozed') return zone(nowMs).date <= zone(r.at_ms).date
  return true
}

interface Shown {
  /** The cards to list, in order: the shown run's items, then the status cards. */
  problems: Problem[]
  /** Which of them are items of the shown run or cards: every id the aside rows may name. */
  ids: string[]
  zone: (ms: number) => { date: string }
}

export function todayStore({ db, hook = s => s }: { db: D1Database; hook?: AuditHook }) {
  const prep = (s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params)

  async function shown(nowMs: number): Promise<Shown> {
    const tz = await brandZone(db)
    const zone = intlZone(tz)
    const today = zone(nowMs).date
    const routineRow = await first<{ id: string; enabled: number; deleted_at_ms: number | null; days_mask: number; hour: number; minute: number }>(
      db, stmt('SELECT id, enabled, deleted_at_ms, days_mask, hour, minute FROM routines WHERE id = ?', MORNING_CHECK_ROUTINE),
    )
    const routine: RoutineFacts | null = routineRow && {
      id: routineRow.id, enabled: routineRow.enabled === 1, deleted: routineRow.deleted_at_ms !== null,
      days_mask: routineRow.days_mask, hour: routineRow.hour, minute: routineRow.minute,
    }
    const slots = await all<SlotFacts>(db, stmt(
      `SELECT slot_key, local_date, local_time, state, reason, failure, result_text, claimed_at_ms, ended_at_ms FROM routine_slots
        WHERE routine_id = ? AND local_date IN (?, ?)`, MORNING_CHECK_ROUTINE, today, dayBefore(today),
    ))
    const view = todayView({ nowMs, tz, routine, slots })
    const currency = await brandCurrency(db)
    const items: TodayItem[] = view.shown === null ? [] : (await all<{ item_json: string }>(
      db, stmt('SELECT item_json FROM today_items WHERE slot_key = ? ORDER BY rowid', view.shown.slot_key),
    )).map(r => TodayItemSchema.parse(JSON.parse(r.item_json)))
    const cards = await Promise.all(view.cards.map(async c => cardProblem(c, await cardId(c.localDate, c.cause, c.hashed), currency)))
    const problems = [...items.map(i => toProblem(i, currency)), ...cards]
    return { problems, ids: problems.map(p => p.id), zone }
  }

  const asideRows = async (ids: readonly string[]): Promise<AsideRow[]> => {
    const rows: AsideRow[] = []
    // D1 binds at most 100 parameters per statement: look the rows up in chunks.
    for (let i = 0; i < ids.length; i += 90) {
      const chunk = ids.slice(i, i + 90)
      rows.push(...await all<AsideRow>(db, stmt(`SELECT item_id, reason, by, at_ms, rev FROM today_aside WHERE item_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)))
    }
    return rows
  }

  return {
    /** Route 57: the cards to show (set aside ones left out) and the records of every card of the shown run. */
    async read(nowMs: number): Promise<{ items: Problem[]; aside: Record<string, TodayAside> }> {
      const s = await shown(nowMs)
      const rows = await asideRows(s.ids)
      const byId = new Map(rows.map(r => [r.item_id, r]))
      return {
        items: s.problems.filter(p => { const r = byId.get(p.id); return r === undefined || !hides(r, nowMs, s.zone) }),
        aside: Object.fromEntries(rows.map(r => [r.item_id, record(r)])),
      }
    },

    /**
     * Route 58: one item's set-aside write, its `today.set_aside` audit line and (for a set-aside, not an Undo) its Activity
     * line, in one batch. `not_found` when the id isn't a card of the shown run or an item Today holds.
     */
    async setAside(w: { id: string; reason: 'snoozed' | 'dismissed' | null; ifRev: number }, at: At): Promise<Outcome<TodayAside, 'not_found'>> {
      const current = await shown(at.nowMs)
      const known = current.ids.includes(w.id) || (await first<{ one: number }>(db, stmt('SELECT 1 AS one FROM today_items WHERE id = ?', w.id))) !== null
      if (!known) return { refused: 'not_found' }
      const stamp = writeStamp(at.requestId)
      const change = w.ifRev === 0
        ? stmt(
          'INSERT INTO today_aside (item_id, reason, by, at_ms, rev, req_id) SELECT ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (SELECT 1 FROM today_aside WHERE item_id = ?)',
          w.id, w.reason, at.actorId, at.nowMs, stamp, w.id,
        )
        : stmt('UPDATE today_aside SET reason = ?, by = ?, at_ms = ?, rev = rev + 1, req_id = ? WHERE item_id = ? AND rev = ?', w.reason, at.actorId, at.nowMs, stamp, w.id, w.ifRev)
      const line = auditInsert(
        { atMs: at.nowMs, actorId: at.actorId, args: { action: 'today.set_aside', itemId: w.id, reason: w.reason }, target: null, requestId: at.requestId },
        { table: 'today_aside', where: 'item_id = ?', params: [w.id], stamp },
      )
      const batch: D1PreparedStatement[] = [prep(change), prep(hook(line))]
      if (w.reason !== null) {
        batch.push(recordActivity(
          db, { template: 'today_set_aside', fields: {}, kind: 'change', actorId: at.actorId, atMs: at.nowMs },
          { source: 'today-aside', key: `${w.id}|${w.ifRev + 1}` },
          { sql: 'EXISTS (SELECT 1 FROM today_aside WHERE item_id = ? AND req_id = ?)', params: [w.id, stamp] },
        ))
      }
      const [result] = await storage('D1', () => db.batch(batch))
      const now = await first<AsideRow>(db, stmt('SELECT item_id, reason, by, at_ms, rev FROM today_aside WHERE item_id = ?', w.id))
      if (result.meta.changes > 0 && now) return { ok: record(now) }
      // Nothing matched: the row isn't at `ifRev` (a stale write, or a first write over an existing row).
      return { conflict: now ? record(now) : { reason: null, at: instant(0), by: at.actorId, loggedAt: instant(0), rev: 0 } }
    },
  }
}
export type TodayStore = ReturnType<typeof todayStore>
