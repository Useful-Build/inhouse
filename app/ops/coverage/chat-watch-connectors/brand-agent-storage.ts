// The BrandAgent's storage for retention (P8 C1): functions over the object's own SQLite (`TaskContext.sql`), so they
// run only inside the object, from the retention handler. They count and delete:
// - an ended run's rows by `runs.ended_at_ms` (the steps period), never a run that isn't safe to drop: a turn that
//   isn't final, a hold not given back, a final turn not yet flushed to D1, a pending file confirm, or the chat's live
//   run (the same conditions as personData's `busy`, shapes.md r4);
// - a chat's rows, with the chat (the chat cascade), unless the chat is busy (a live or waiting session, or a turn of
//   it as above): a busy chat is skipped and goes on a later run.
// `turn_trace`, `ledger_queue` and the other per-turn tables go with their turn; `pool_queue` and `turn_effects` exist only while
// a turn is live, so a safe run has none (deleted anyway). `flags`, `authority` and the pool's own tables hold no run.
// Durable Objects SQLite storage: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (read 2026-11-22)

/** The per-turn tables, then the run-level ones, in delete order (children first). */
export const PER_TURN_TABLES = ['model_calls', 'ledger_queue', 'pool_queue', 'turn_effects', 'turn_trace', 'turn_rows'] as const
export const RUN_TABLES = ['events', 'run_tokens', ...PER_TURN_TABLES, 'turns', 'runs'] as const
export const CHAT_TABLES = [...RUN_TABLES, 'chat_state', 'chat_deletion'] as const
export type AgentTable = (typeof CHAT_TABLES)[number]

/** The columns these functions read, per table: the schema-pin test checks the object still has each. */
export const USED_COLUMNS: Readonly<Record<AgentTable, readonly string[]>> = {
  runs: ['run_id', 'chat_id', 'state', 'ended_at_ms'],
  turns: ['turn_id', 'run_id', 'chat_id', 'state', 'reserved', 'settled', 'd1_flushed'],
  events: ['run_id'],
  run_tokens: ['run_id', 'chat_id'],
  model_calls: ['turn_id'],
  ledger_queue: ['turn_id'],
  pool_queue: ['turn_id'],
  turn_effects: ['turn_id'],
  turn_trace: ['turn_id'],
  turn_rows: ['turn_id', 'chat_id'],
  chat_state: ['chat_id', 'live_run_id', 'session'],
  chat_deletion: ['chat_id'],
}

const exists = (sql: SqlStorage, table: string) => sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0
const marks = (n: number) => Array.from({ length: n }, () => '?').join(', ')

/** A turn that isn't safe to drop (personData's `busy` conditions, per turn). */
const UNSAFE_TURN = `(t.state NOT IN ('ended', 'cancelled') OR (t.reserved > 0 AND t.settled = 0) OR t.d1_flushed = 0
  OR EXISTS (SELECT 1 FROM turn_effects e WHERE e.turn_id = t.turn_id))`

/** Ended runs strictly before `cutoffMs` that are safe to drop, in run order: at most `limit`, and whether more wait. */
export function endedRuns(sql: SqlStorage, cutoffMs: number, limit: number): { runIds: string[]; more: boolean } {
  const rows = sql.exec<{ run_id: string }>(`SELECT r.run_id FROM runs r WHERE r.state = 'ended' AND r.ended_at_ms < ?
    AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.run_id AND ${UNSAFE_TURN})
    AND NOT EXISTS (SELECT 1 FROM chat_state cs WHERE cs.live_run_id = r.run_id)
    ORDER BY r.run_id LIMIT ?`, cutoffMs, limit + 1).toArray()
  return { runIds: rows.slice(0, limit).map(r => r.run_id), more: rows.length > limit }
}

/** Ended runs strictly before `cutoffMs` that are blocked by an unsafe turn or a live chat run. */
export function blockedEndedRuns(sql: SqlStorage, cutoffMs: number): string[] {
  return sql.exec<{ run_id: string }>(`SELECT r.run_id FROM runs r WHERE r.state = 'ended' AND r.ended_at_ms < ?
    AND (EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.run_id AND ${UNSAFE_TURN})
      OR EXISTS (SELECT 1 FROM chat_state cs WHERE cs.live_run_id = r.run_id))
    ORDER BY r.run_id`, cutoffMs).toArray().map(r => r.run_id)
}

/** Of `chatIds`, the ones whose BrandAgent rows can go now (no live or waiting session, no unsafe turn). */
export function quietChats(sql: SqlStorage, chatIds: readonly string[]): string[] {
  if (chatIds.length === 0) return []
  const busy = new Set(sql.exec<{ chat_id: string }>(`SELECT chat_id FROM chat_state WHERE chat_id IN (${marks(chatIds.length)})
      AND (live_run_id IS NOT NULL OR session = 'waiting')
    UNION SELECT t.chat_id FROM turns t WHERE t.chat_id IN (${marks(chatIds.length)}) AND ${UNSAFE_TURN}`, ...chatIds, ...chatIds).toArray().map(r => r.chat_id))
  return chatIds.filter(id => !busy.has(id))
}

type Where = { where: string; args: SqlStorageValue[] }

function runWhere(table: (typeof RUN_TABLES)[number], runIds: readonly string[]): Where {
  const ids = marks(runIds.length)
  if ((PER_TURN_TABLES as readonly string[]).includes(table)) return { where: `turn_id IN (SELECT turn_id FROM turns WHERE run_id IN (${ids}))`, args: [...runIds] }
  return { where: `run_id IN (${ids})`, args: [...runIds] }
}

function chatWhere(table: AgentTable, chatIds: readonly string[]): Where {
  const ids = marks(chatIds.length)
  if (table === 'events') return { where: `run_id IN (SELECT run_id FROM runs WHERE chat_id IN (${ids}))`, args: [...chatIds] }
  if ((PER_TURN_TABLES as readonly string[]).includes(table) && table !== 'turn_rows') return { where: `turn_id IN (SELECT turn_id FROM turns WHERE chat_id IN (${ids}))`, args: [...chatIds] }
  return { where: `chat_id IN (${ids})`, args: [...chatIds] }
}

function countWhere(sql: SqlStorage, tables: readonly AgentTable[], whereOf: (t: AgentTable) => Where): Record<string, number> {
  const out: Record<string, number> = {}
  for (const t of tables) {
    if (!exists(sql, t)) continue
    const w = whereOf(t)
    out[t] = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE ${w.where}`, ...w.args).one().n
  }
  return out
}

function deleteWhere(sql: SqlStorage, tables: readonly AgentTable[], whereOf: (t: AgentTable) => Where): Record<string, number> {
  // Counted first, then deleted children first, so a per-turn table's rows are found through turns that still exist.
  const counts = countWhere(sql, tables, whereOf)
  for (const t of tables) {
    if (!exists(sql, t)) continue
    const w = whereOf(t)
    sql.exec(`DELETE FROM ${t} WHERE ${w.where}`, ...w.args)
  }
  return counts
}

export const countRunRows = (sql: SqlStorage, runIds: readonly string[]) => (runIds.length === 0 ? {} : countWhere(sql, RUN_TABLES, t => runWhere(t as (typeof RUN_TABLES)[number], runIds)))
export const deleteRunRows = (sql: SqlStorage, runIds: readonly string[]) => (runIds.length === 0 ? {} : deleteWhere(sql, RUN_TABLES, t => runWhere(t as (typeof RUN_TABLES)[number], runIds)))
export const countChatRows = (sql: SqlStorage, chatIds: readonly string[]) => (chatIds.length === 0 ? {} : countWhere(sql, CHAT_TABLES, t => chatWhere(t, chatIds)))
export const deleteChatRows = (sql: SqlStorage, chatIds: readonly string[]) => (chatIds.length === 0 ? {} : deleteWhere(sql, CHAT_TABLES, t => chatWhere(t, chatIds)))

/** The tables and columns above that the object's schema lacks, as `table.column` (the schema-pin test). */
export function missingColumns(sql: SqlStorage): string[] {
  const missing: string[] = []
  for (const [table, columns] of Object.entries(USED_COLUMNS)) {
    const have = new Set(sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table).toArray().map(r => r.name))
    if (have.size === 0) {
      missing.push(table)
      continue
    }
    for (const c of columns) if (!have.has(c)) missing.push(`${table}.${c}`)
  }
  return missing
}
