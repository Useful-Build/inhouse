// N14's admission (Stage 1 M2-D): every write proposal is bound to a real call by the main agent in a live turn. The
// runner's audit hook posts each tool call to the egress's `/audit/` and blocks the call until the Worker has stored
// it (egress/audit.ts); M1-E added who made the call (`agentId`, null for the main agent) and the SHA-256 of its raw
// input (`inputSha256`). The calls that can propose a write (the `actions` server's tools, and `approval_request` and,
// since M2-N, `notification_send` on the `inhouse` server) are kept here, in BrandAgent's SQLite, as `tool_invocations`.
//
// `admitAction(turnId, tool, inputSha256)` is one synchronous step: the turn is live and not fenced, the brand isn't
// paused, the turn's person isn't removed, and an unused invocation of this turn matches the tool name and the hash and
// has no `agent_id`. It marks that invocation used and answers its `tool_use_id`, which the outbox keys the action on.
// So a helper's call, a hand-made request and a replay with other arguments all fail; the JSON-RPC id and any id in a
// request body are never trusted. The same call made again (the same tool and input, with every matching invocation
// already used) is answered with the last one's `tool_use_id`: the outbox then returns that call's action as it is,
// and nothing new is asked or sent.
import type { AuditEntry } from '../../../shared/protocol/index.ts'

/** The `actions` MCP server's tools as the SDK names them (`mcp__actions__<tool>`; runner/src/session/mcp-servers.ts). */
export const ACTIONS_TOOL_PREFIX = 'mcp__actions__'
/** `approval_request` on the `inhouse` server, as the SDK names it. */
export const APPROVAL_REQUEST_TOOL = 'mcp__inhouse__approval_request'

/** `notification_send` on the `inhouse` server: since M2-N its post to a listed Slack channel goes through the outbox. */
export const NOTIFICATION_SEND_TOOL = 'mcp__inhouse__notification_send'

/** Whether a tool call can propose a write, so its invocation is kept for admission. */
export const proposesWrite = (toolName: string): boolean =>
  toolName.startsWith(ACTIONS_TOOL_PREFIX) || toolName === APPROVAL_REQUEST_TOOL || toolName === NOTIFICATION_SEND_TOOL

/** Invocations are kept a day: no turn lives that long (a job's turns are each shorter than its 8-hour cap). */
export const INVOCATION_KEEP_MS = 24 * 60 * 60_000

export function createInvocationTables(sql: SqlStorage): void {
  // No person key: a turn, a call and a hash. Rows go after `INVOCATION_KEEP_MS` (the asks sweep, asks.ts).
  sql.exec(`CREATE TABLE IF NOT EXISTS tool_invocations (turn_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, tool_name TEXT NOT NULL,
    agent_id TEXT, input_sha256 TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, at_ms INTEGER NOT NULL, PRIMARY KEY (turn_id, tool_use_id))`)
  sql.exec('CREATE INDEX IF NOT EXISTS tool_invocations_match ON tool_invocations(turn_id, tool_name, input_sha256)')
}

/**
 * Keeps an audited call that can propose a write (the audit route, after its `tool_calls` row). Only an entry that says
 * who made it and carries the raw input's hash (a runner at protocol v4) is kept: one without them proves nothing about
 * who made the call, so no write is ever admitted on it. A denied call never ran. The same call posted twice is kept once.
 */
export function recordInvocation(sql: SqlStorage, turnId: string, entry: AuditEntry, nowMs: number): boolean {
  if (!proposesWrite(entry.toolName) || entry.decision === 'deny') return false
  if (entry.toolUseId === undefined || entry.inputSha256 === undefined || entry.agentId === undefined) return false
  sql.exec(
    `INSERT INTO tool_invocations (turn_id, tool_use_id, tool_name, agent_id, input_sha256, at_ms) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (turn_id, tool_use_id) DO NOTHING`,
    turnId, entry.toolUseId, entry.toolName, entry.agentId, entry.inputSha256, nowMs,
  )
  return true
}

/** The asking turn as admission reads it (core.ts `TurnRow`'s columns). */
export interface AdmitTurn {
  turn_id: string; run_id: string; chat_id: string; owner_id: string; state: string; fenced: number; job_id: string | null
}

export type AdmitRefusal = 'turn_not_live' | 'paused' | 'member_removed' | 'no_match'
export type Admitted = { toolUseId: string; turnId: string; runId: string; chatId: string; ownerId: string; jobId: string | null; replay: boolean }

/**
 * N14's `admitAction`, one synchronous step on the object's SQLite. `turn`, `paused` and `removed` are read by the
 * caller in the same step (core.ts).
 */
export function admitAction(
  sql: SqlStorage,
  facts: { turn: AdmitTurn | null; paused: boolean; removed: (memberId: string) => boolean },
  tool: string,
  inputSha256: string,
): Admitted | { refused: AdmitRefusal } {
  const t = facts.turn
  if (!t || t.fenced === 1 || !(t.state === 'live' || t.state === 'starting')) return { refused: 'turn_not_live' }
  if (facts.paused) return { refused: 'paused' }
  if (facts.removed(t.owner_id)) return { refused: 'member_removed' }
  if (!proposesWrite(tool)) return { refused: 'no_match' }
  const admitted = (toolUseId: string, replay: boolean): Admitted =>
    ({ toolUseId, turnId: t.turn_id, runId: t.run_id, chatId: t.chat_id, ownerId: t.owner_id, jobId: t.job_id, replay })
  const fresh = sql.exec<{ tool_use_id: string }>(
    `UPDATE tool_invocations SET used = 1 WHERE rowid = (
       SELECT rowid FROM tool_invocations WHERE turn_id = ? AND tool_name = ? AND input_sha256 = ? AND agent_id IS NULL AND used = 0
       ORDER BY at_ms, tool_use_id LIMIT 1)
     RETURNING tool_use_id`,
    t.turn_id, tool, inputSha256,
  ).toArray()[0]
  if (fresh) return admitted(fresh.tool_use_id, false)
  const again = sql.exec<{ tool_use_id: string }>(
    `SELECT tool_use_id FROM tool_invocations WHERE turn_id = ? AND tool_name = ? AND input_sha256 = ? AND agent_id IS NULL AND used = 1
     ORDER BY at_ms DESC, tool_use_id DESC LIMIT 1`,
    t.turn_id, tool, inputSha256,
  ).toArray()[0]
  return again ? admitted(again.tool_use_id, true) : { refused: 'no_match' }
}

/** Whether this turn admitted any write proposal (so its end needs the asks' turn-end step). */
export const turnProposed = (sql: SqlStorage, turnId: string): boolean =>
  sql.exec('SELECT 1 FROM tool_invocations WHERE turn_id = ? AND used = 1 LIMIT 1', turnId).toArray().length > 0

/** Drops invocations older than `INVOCATION_KEEP_MS`. */
export const pruneInvocations = (sql: SqlStorage, nowMs: number): void => {
  sql.exec('DELETE FROM tool_invocations WHERE at_ms < ?', nowMs - INVOCATION_KEEP_MS)
}
