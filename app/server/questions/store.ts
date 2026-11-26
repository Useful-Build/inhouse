// Stage 1 M2-Q (N16): the `questions` table (0740). Every change is a guarded statement, so a question moves only
// forward: `open` to `answered` (the first answer wins), `expired` or `closed`; `answered` to `closed` when nothing waits
// for the answer any more. Each change and its audit line and notice go in one batch. Never the question's words, its
// options or the answer in an audit line or a log.
import { addNotice } from '../notices/store.ts'
import { auditInsert } from '../db/audit.ts'
import { stmt, storage } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'
import type { AskedAs, QuestionRow, QuestionViewer } from './types.ts'

/** The bell link for a question: the Questions section on Approvals (M2-H). */
const LINK = { to: 'page', page: 'approvals' } as const

/** Who a question's notice reaches: one member, or every admin. */
const audienceOf = (askedOf: string) =>
  askedOf === 'admins' ? { audience: 'admins' as const } : { audience: 'member' as const, audienceMemberId: askedOf }

const prepare = (db: D1Database, s: Stmt): D1PreparedStatement => db.prepare(s.sql).bind(...s.params)

/** Who wrote a change: a member id (or `m_system`), the request and the clock. */
export interface QuestionAt { actorId: string; requestId: string; nowMs: number }

export interface NewQuestion {
  id: string; chatId: string; turnId: string; toolUseId: string
  askedOf: string; askedAs: AskedAs
  question: string; options: string[]
  createdAtMs: number; expiresAtMs: number
}

export interface QuestionStore {
  get(id: string): Promise<QuestionRow | null>
  /** The question a tool call asked, by the call's id in its chat. */
  byToolUse(chatId: string, toolUseId: string): Promise<QuestionRow | null>
  /**
   * The open questions asked of this viewer and not past their expiry, oldest first. Not a chat in the trash (or gone):
   * its question stays open, so a restore brings it back.
   */
  openFor(viewer: QuestionViewer, nowMs: number): Promise<QuestionRow[]>
  /** This member's answers whose resume never landed (answered, not delivered), oldest first. */
  undeliveredBy(memberId: string): Promise<QuestionRow[]>
  /** The chat is in the trash, or not in D1 at all. */
  chatGone(chatId: string): Promise<boolean>
  /**
   * Asks the question: the row, its `question.asked` line and its bell notice, in one batch. `false` when a question
   * with this id or for this tool call is already there (nothing written).
   */
  create(q: NewQuestion, at: QuestionAt): Promise<boolean>
  /** The first answer: `open` to `answered`, with its `question.answered` line. `false` when it wasn't open. */
  answer(id: string, choice: string, at: QuestionAt): Promise<boolean>
  /** `open` to `expired`, with its `question.expired` line. `false` when it wasn't open. */
  expire(id: string, at: QuestionAt): Promise<boolean>
  /** The bell's "A question was closed" for an expired question, once (its id is the question's). */
  expiredNotice(row: QuestionRow, nowMs: number): Promise<void>
  /** Its turn no longer waits on it: `open` to `closed`. `false` when it wasn't open. */
  withdraw(id: string, nowMs: number): Promise<boolean>
  /** The resume found no wait for its answer: `answered` (never delivered) to `closed`, the answer kept. */
  unanswerable(id: string): Promise<boolean>
  /** The resume took the answer: `delivered_at_ms`, once. */
  delivered(id: string, nowMs: number): Promise<void>
}

export function questionStore(d: { db: D1Database }): QuestionStore {
  const { db } = d
  const one = (s: Stmt) => storage('D1', () => prepare(db, s).first<QuestionRow>())
  const changed = async (stmts: Stmt[], notices: D1PreparedStatement[] = []): Promise<boolean> => {
    const results = await storage('D1', () => db.batch([...stmts.map(s => prepare(db, s)), ...notices]))
    return (results[0]?.meta.changes ?? 0) > 0
  }
  return {
    get: id => one(stmt('SELECT * FROM questions WHERE id = ?', id)),
    byToolUse: (chatId, toolUseId) => one(stmt('SELECT * FROM questions WHERE chat_id = ? AND tool_use_id = ?', chatId, toolUseId)),
    async openFor(viewer, nowMs) {
      const admin = viewer.role === 'admin' ? 1 : 0
      const r = await storage('D1', () => prepare(db, stmt(
        `SELECT q.* FROM questions q JOIN chats c ON c.id = q.chat_id AND c.deleted_at_ms IS NULL
          WHERE q.state = 'open' AND q.expires_at_ms > ? AND (q.asked_of = ? OR (q.asked_of = 'admins' AND ? = 1))
          ORDER BY q.created_at_ms, q.id`, nowMs, viewer.memberId, admin)).all<QuestionRow>())
      return r.results
    },
    async undeliveredBy(memberId) {
      const r = await storage('D1', () => prepare(db, stmt(
        `SELECT * FROM questions WHERE state = 'answered' AND delivered_at_ms IS NULL AND answered_by = ? ORDER BY answered_at_ms, id`,
        memberId)).all<QuestionRow>())
      return r.results
    },
    async chatGone(chatId) {
      const c = await storage('D1', () => prepare(db, stmt('SELECT deleted_at_ms FROM chats WHERE id = ?', chatId)).first<{ deleted_at_ms: number | null }>())
      return c === null || c.deleted_at_ms !== null
    },
    async create(q, at) {
      const insert = stmt(
        `INSERT INTO questions (id, chat_id, turn_id, tool_use_id, asked_of, asked_as, question, options_json, state, created_at_ms,
          expires_at_ms, req_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT DO NOTHING`,
        q.id, q.chatId, q.turnId, q.toolUseId, q.askedOf, q.askedAs, q.question, JSON.stringify(q.options), q.createdAtMs, q.expiresAtMs, at.requestId)
      const line = auditInsert({
        atMs: at.nowMs, actorId: at.actorId, args: { action: 'question.asked', questionId: q.id, askedOf: q.askedAs, options: q.options.length },
        target: null, requestId: at.requestId,
      }, { table: 'questions', where: 'id = ? AND created_at_ms = ?', params: [q.id, q.createdAtMs], stamp: at.requestId })
      // The notice's id is the question's: a retried ask writes it once.
      const notice = addNotice(db, { id: `qw_${q.id}`, ...audienceOf(q.askedOf), template: 'question_waiting', fields: {}, icon: 'help', waiting: true, link: LINK, atMs: at.nowMs })
      return changed([insert, line], [notice])
    },
    async answer(id, choice, at) {
      const update = stmt(
        `UPDATE questions SET state = 'answered', answer = ?, answered_by = ?, answered_at_ms = ?, ended_at_ms = ?, req_id = ?
          WHERE id = ? AND state = 'open'`, choice, at.actorId, at.nowMs, at.nowMs, at.requestId, id)
      const line = auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'question.answered', questionId: id }, target: null, requestId: at.requestId },
        { table: 'questions', where: "id = ? AND state = 'answered'", params: [id], stamp: at.requestId })
      return changed([update, line])
    },
    async expire(id, at) {
      const update = stmt("UPDATE questions SET state = 'expired', ended_at_ms = ?, req_id = ? WHERE id = ? AND state = 'open'", at.nowMs, at.requestId, id)
      const line = auditInsert({ atMs: at.nowMs, actorId: at.actorId, args: { action: 'question.expired', questionId: id }, target: null, requestId: at.requestId },
        { table: 'questions', where: "id = ? AND state = 'expired'", params: [id], stamp: at.requestId })
      return changed([update, line])
    },
    async expiredNotice(row, nowMs) {
      if (row.state !== 'expired') throw new Error('expiredNotice: the question has not expired')
      await storage('D1', () => addNotice(db, { id: `qc_${row.id}`, ...audienceOf(row.asked_of), template: 'question_closed', fields: {}, icon: 'help', link: LINK, atMs: nowMs }).run())
    },
    withdraw: (id, nowMs) => changed([stmt("UPDATE questions SET state = 'closed', ended_at_ms = ? WHERE id = ? AND state = 'open'", nowMs, id)]),
    unanswerable: id => changed([stmt("UPDATE questions SET state = 'closed' WHERE id = ? AND state = 'answered' AND delivered_at_ms IS NULL", id)]),
    async delivered(id, nowMs) {
      await storage('D1', () => prepare(db, stmt('UPDATE questions SET delivered_at_ms = ? WHERE id = ? AND delivered_at_ms IS NULL AND answer IS NOT NULL', nowMs, id)).run())
    },
  }
}
