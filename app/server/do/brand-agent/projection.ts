// The history projection to D1 (p3-design 4.8). Owner: W1. At a turn's end its rows are fixed in the object first, in
// the same synchronous step that stores the turn as final (core.ts `storeFinal`): positions `pos_from..pos_to` from the
// chat's `next_pos`, and each row's values (the user message `<turnId>.u` with its quote and attachments, then the
// turn's parts `<turnId>.<n>` with their model and `at` and a trace reference, then the end row
// `<turnId>.f`/`.x` of a failed, stopped or never-run turn). Then one D1 batch inserts them
// `ON CONFLICT(id) DO NOTHING` and moves `chats.last_at_ms` forward. A failed batch is replayed by the
// `flush-turn:<turnId>` task with the SAME fixed rows: positions are never computed twice.
import type { ChatEvent } from '../../../shared/contract/runs.ts'
import { CANCEL } from '../../../shared/contract/chat-codes.ts'
import type { StoredAttachment } from './run-start.ts'
import { JOB_TURN_FAILURES_SHOWN, isServerTurnSource, type ServerTurnSource } from '../../../shared/server-turn-text.ts'

/** `turns.source` and the `.u` row's `extra_json.source` of a job's continuation (Stage 1, N3). */
export const JOB_SOURCE = 'job'

/** The flush's durable retry runs this long after the turn's end when the immediate flush didn't land. */
export const FLUSH_RETRY_MS = 30_000
export const FLUSH_TURN_PREFIX = 'flush-turn:'

/** One `chat_messages` row as D1 gets it (0100); `n` is D1's own. */
export interface ProjectedRow {
  id: string
  chat_id: string
  run_id: string
  turn_id: string
  pos: number
  role: 'user' | 'agent' | 'event'
  author_id: string | null
  text: string
  part_json: string | null
  extra_json: string | null
  model: string | null
  at_ms: number
}

/** The fixed rows of one turn and the time `chats.last_at_ms` moves to. */
export interface Projection { chatId: string; atMs: number; rows: ProjectedRow[] }

/**
 * The `turn_rows` table: one row per final turn, its projection as JSON. Created with the BrandAgent's other tables
 * (schema.ts); kept here beside the code that writes it.
 */
export const TURN_ROWS_TABLE = `CREATE TABLE IF NOT EXISTS turn_rows (turn_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL, json TEXT NOT NULL)`

interface TurnForRows {
  [k: string]: SqlStorageValue
  turn_id: string; run_id: string; chat_id: string; owner_id: string; text: string; quote: string | null
  attachments_json: string; created_at_ms: number; pos_from: number | null
  outcome: string | null; failure: string | null; cancel_why: string | null; started_at_ms: number | null; ended_at_ms: number | null
  source: string | null; job_id: string | null; job_n: number | null; cut_cause: string | null; person_stop: number
}

/**
 * Cancels the chat says nothing about, live or after a reload: the person's membership was removed (`onMemberRemoved`)
 * or the chat was deleted. No end row.
 */
export const SILENT_CANCELS: readonly string[] = [CANCEL.removed, CANCEL.deleted]

/**
 * The end row: what the live stream shows at a turn's end beside its parts, kept so a reload shows it too. An `event`
 * row (never in the agent's own history or search, which read `user` and `agent` rows only) with the code, not the words:
 * the client renders it with the same text and id as the live message, so the two show once.
 * - `<turnId>.f` `{ failure, retryQuestion }`: a failed turn (`turn.finished` failed). `retryQuestion` is the turn's text,
 *   or for a job's continuation the person's own question that started the job (M1-P): never the server's job text;
 * - `<turnId>.x` `{ outcome }`: a stopped or interrupted one (`turn.finished` stopped/interrupted, the stopped note);
 * - `<turnId>.x` `{ why }`: a turn cancelled (`turn.cancelled`) for a reason that has words, whether it was still waiting or had
 *   gone live (a pause stops an answer being written), whatever state the cancel left it in (a pause during a placement
 *   fences it to `ended`). The client words both live, so a reload agrees. (Until the first ship recording a turn that went
 *   live kept no row, because the client wordless-ignored its cancel.)
 * A long job's own turn ends (Stage 1 M1-D) keep no row: the job's progress row and result card speak for them, and the
 * next continuation's row says the agent carried on. That is a promoted root (it became the job, `job_n = 0`), and a
 * continuation that failed in a way the job carries on from, retries or ends for its budget (all but
 * JOB_TURN_FAILURES_SHOWN, shared/server-turn-text.ts) or that the server cut (`job_cut`, `job_deadline`). A person's Stop, Cancel or interrupt, or their new message taking the turn's place, keeps the
 * stopped note. The live view (src/screens/chat/view.ts) shows the same.
 */
function endRow(t: TurnForRows, retryQuestion: string): { id: string; extra: Record<string, string> } | null {
  if (t.job_id !== null && t.job_n === 0) return null
  if (t.job_id !== null && t.outcome === 'failed' && !JOB_TURN_FAILURES_SHOWN.has(t.failure ?? 'unknown')) return null
  if (t.job_id !== null && t.outcome === 'interrupted' && t.person_stop === 0 && t.cut_cause !== 'message') return null
  if (t.outcome === 'failed') return { id: `${t.turn_id}.f`, extra: { failure: t.failure ?? 'unknown', retryQuestion } }
  if (t.outcome === 'stopped' || t.outcome === 'interrupted') return { id: `${t.turn_id}.x`, extra: { outcome: t.outcome } }
  // A turn that was answered and then fenced (a pause in the grace window) keeps its outcome and still writes a reason: not a cancel.
  if (t.cancel_why !== null && (t.outcome === null || t.outcome === 'cancelled') && !SILENT_CANCELS.includes(t.cancel_why)) return { id: `${t.turn_id}.x`, extra: { why: t.cancel_why } }
  return null
}

/**
 * Fixes the turn's rows (synchronous; call inside the final-state step). Idempotent: a turn that already has its
 * positions keeps them and its stored rows. Returns the projection.
 */
export function fixTurnRows(sql: SqlStorage, turnId: string, atMs: number): Projection {
  const t = sql.exec<TurnForRows>(
    `SELECT turn_id, run_id, chat_id, owner_id, text, quote, attachments_json, created_at_ms, pos_from, outcome, failure,
      cancel_why, started_at_ms, ended_at_ms, source, job_id, job_n, cut_cause, person_stop FROM turns WHERE turn_id = ?`, turnId).one()
  if (t.pos_from !== null) return storedProjection(sql, turnId)!
  const from = sql.exec<{ p: number }>('SELECT next_pos AS p FROM chat_state WHERE chat_id = ?', t.chat_id).one().p
  const atts = JSON.parse(t.attachments_json) as StoredAttachment[]
  const extra: { quote?: string; attachments?: { fileId: string; name: string }[]; source?: ServerTurnSource } = {}
  if (t.quote !== null) extra.quote = t.quote
  // A turn the server wrote (M1-P's job continuation; M1-D: an action's or a question's resume too): its text is never
  // the person's. Its `.u` row says so, so a reload and an export show the server's note (db/chats.ts) and the agent's
  // history tools leave it out, never as something the person typed.
  if (isServerTurnSource(t.source)) extra.source = t.source
  if (atts.length > 0) extra.attachments = atts.map(a => ({ fileId: a.fileId, name: a.name }))
  const base = { chat_id: t.chat_id, run_id: t.run_id, turn_id: t.turn_id }
  const rows: ProjectedRow[] = [{
    ...base, id: `${turnId}.u`, pos: from, role: 'user', author_id: t.owner_id, text: t.text, part_json: null,
    extra_json: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null, model: null, at_ms: t.created_at_ms,
  }]
  const parts = sql.exec<{ json: string }>('SELECT json FROM events WHERE run_id = ? AND turn_id = ? ORDER BY seq', t.run_id, turnId).toArray()
  for (const e of parts) {
    const ev = JSON.parse(e.json) as ChatEvent
    if (ev.type !== 'part') continue
    rows.push({
      ...base, id: ev.messageId, pos: from + rows.length, role: 'agent', author_id: null,
      text: ev.part.type === 'text' ? ev.part.text : '', part_json: JSON.stringify(ev.part),
      extra_json: JSON.stringify({ trace: turnId }), model: ev.model, at_ms: ev.at.ms,
    })
  }
  // Try again asks the person's own question: a job's root's for its continuation, none for an action's or question's resume.
  // A question's resume inside a job is the job's turn too (`job_id` set by jobs/engine.ts `resumed`): the root's question.
  const ofJob = t.job_id !== null && t.job_n !== 0
  const end = endRow(t, ofJob ? jobQuestion(sql, t) : isServerTurnSource(t.source) ? '' : t.text)
  if (end) {
    rows.push({
      ...base, id: end.id, pos: from + rows.length, role: 'event', author_id: null, text: '', part_json: null,
      extra_json: JSON.stringify(end.extra), model: null, at_ms: t.ended_at_ms ?? atMs,
    })
  }
  const to = from + rows.length - 1
  sql.exec('UPDATE turns SET pos_from = ?, pos_to = ? WHERE turn_id = ?', from, to, turnId)
  sql.exec('UPDATE chat_state SET next_pos = ? WHERE chat_id = ?', to + 1, t.chat_id)
  sql.exec('INSERT INTO turn_rows (turn_id, chat_id, at_ms, json) VALUES (?, ?, ?, ?)', turnId, t.chat_id, atMs, JSON.stringify(rows))
  return { chatId: t.chat_id, atMs, rows }
}

/**
 * The question that started a continuation's job: its root turn's text (the person's). A job or root row that's gone is
 * a bug, logged loudly; the end row is still stored, with no question (so no Try again), since throwing here would
 * break the turn's final step.
 */
function jobQuestion(sql: SqlStorage, t: TurnForRows): string {
  const r = sql.exec<{ text: string }>(
    'SELECT r.text AS text FROM jobs j JOIN turns r ON r.turn_id = j.root_turn_id WHERE j.job_id = ?', t.job_id).toArray()[0]
  if (r === undefined) {
    console.error({ event: 'projection_job_question_missing', turnId: t.turn_id, jobId: t.job_id })
    return ''
  }
  return r.text
}

/** The turn's fixed rows, or null when it has none (not final yet). */
export function storedProjection(sql: SqlStorage, turnId: string): Projection | null {
  const r = sql.exec<{ chat_id: string; at_ms: number; json: string }>('SELECT chat_id, at_ms, json FROM turn_rows WHERE turn_id = ?', turnId).toArray()[0]
  return r ? { chatId: r.chat_id, atMs: r.at_ms, rows: JSON.parse(r.json) as ProjectedRow[] } : null
}

const COLUMNS = ['id', 'chat_id', 'run_id', 'turn_id', 'pos', 'role', 'author_id', 'text', 'part_json', 'extra_json', 'model', 'at_ms'] as const

/** The one D1 batch: every row `ON CONFLICT(id) DO NOTHING`, then `chats.last_at_ms = MAX(last_at_ms, :at)`. */
export async function writeProjection(db: D1Database, p: Projection): Promise<void> {
  const insert = `INSERT INTO chat_messages (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')}) ON CONFLICT(id) DO NOTHING`
  await db.batch([
    ...p.rows.map(r => db.prepare(insert).bind(...COLUMNS.map(c => r[c]))),
    db.prepare('UPDATE chats SET last_at_ms = MAX(last_at_ms, ?) WHERE id = ?').bind(p.atMs, p.chatId),
  ])
}
