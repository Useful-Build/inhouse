// The send ledger (p5-w4.md sections 7 and 8): one `notify_sends` row per recipient, reserved before the send in ONE
// statement that checks the caps, so concurrent runs can't pass a cap together, then read back by its dedupe key. The
// agent's statements count only `source = 'agent'` rows and the system's only the others, so neither group can eat the
// other's allowance. A reservation counts whatever happens next (posted, refused at the hub, failed, or no answer).
import { all, first, stmt } from '../db/sql.ts'
import type { Stmt } from '../db/sql.ts'

export type SendKind = 'slack' | 'bell'
export type SendOutcome = 'reserved' | 'posted' | 'refused' | 'failed'
export type SystemSource = 'approvals' | 'questions' | 'routines'

/** The caps (OC-W4-3 and OC-W4-7). */
export const AGENT_CAPS: Readonly<Record<SendKind, { run: number; day: number }>> = { slack: { run: 3, day: 20 }, bell: { run: 10, day: 100 } }
export const SYSTEM_CAPS: Readonly<Record<SendKind, { run: number | null; day: number }>> = { slack: { run: 3, day: 50 }, bell: { run: null, day: 500 } }

export type SendRow = { id: string; outcome: SendOutcome; detail: string | null; slack_ts: string | null }

/** The UTC date of an instant, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export type AgentReservation = { id: string; runId: string; turnId: string; actorId: string; kind: SendKind; target: string; sha: string; atMs: number }

/** The agent's reservation: inserted only while the run's and the day's counts are under the caps. */
export function reserveAgent(r: AgentReservation): Stmt {
  const caps = AGENT_CAPS[r.kind]
  const day = utcDay(r.atMs)
  return stmt(
    `INSERT INTO notify_sends (id, source, run_id, system_key, turn_id, actor_id, kind, target, day, notice_sha256, outcome, at_ms, notice_kind)
     SELECT ?, 'agent', ?, NULL, ?, ?, ?, ?, ?, ?, 'reserved', ?, NULL
     WHERE (SELECT count(*) FROM notify_sends WHERE source = 'agent' AND run_id = ? AND kind = ?) < ?
       AND (SELECT count(*) FROM notify_sends WHERE source = 'agent' AND kind = ? AND day = ?) < ?
     ON CONFLICT DO NOTHING`,
    r.id, r.runId, r.turnId, r.actorId, r.kind, r.target, day, r.sha, r.atMs,
    r.runId, r.kind, caps.run,
    r.kind, day, caps.day,
  )
}

export type SystemReservation = { id: string; source: SystemSource; runId: string | null; key: string; noticeKind: string; actorId: string; kind: SendKind; target: string; sha: string; atMs: number }

/** A system notice's reservation: the day cap always, the per-run Slack cap only when the causing run is known. */
export function reserveSystem(r: SystemReservation): Stmt {
  const caps = SYSTEM_CAPS[r.kind]
  const day = utcDay(r.atMs)
  const runCap = r.runId !== null && caps.run !== null ? caps.run : null
  return stmt(
    `INSERT INTO notify_sends (id, source, run_id, system_key, turn_id, actor_id, kind, target, day, notice_sha256, outcome, at_ms, notice_kind)
     SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'reserved', ?, ?
     WHERE (? IS NULL OR (SELECT count(*) FROM notify_sends WHERE source <> 'agent' AND run_id = ? AND kind = ?) < ?)
       AND (SELECT count(*) FROM notify_sends WHERE source <> 'agent' AND kind = ? AND day = ?) < ?
     ON CONFLICT DO NOTHING`,
    r.id, r.source, r.runId, r.key, r.actorId, r.kind, r.target, day, r.sha, r.atMs, r.noticeKind,
    runCap, r.runId, r.kind, runCap ?? 0,
    r.kind, day, caps.day,
  )
}

export async function agentRow(db: D1Database, r: Pick<AgentReservation, 'runId' | 'kind' | 'target' | 'sha'>): Promise<SendRow | null> {
  return first<SendRow>(db, stmt(
    "SELECT id, outcome, detail, slack_ts FROM notify_sends WHERE source = 'agent' AND run_id = ? AND kind = ? AND target = ? AND notice_sha256 = ?",
    r.runId, r.kind, r.target, r.sha,
  ))
}

export async function systemRow(db: D1Database, r: Pick<SystemReservation, 'source' | 'key' | 'noticeKind' | 'kind' | 'target'>): Promise<SendRow | null> {
  return first<SendRow>(db, stmt(
    "SELECT id, outcome, detail, slack_ts FROM notify_sends WHERE source <> 'agent' AND source = ? AND system_key = ? AND notice_kind = ? AND kind = ? AND target = ?",
    r.source, r.key, r.noticeKind, r.kind, r.target,
  ))
}

/** Which cap refused a reservation that wrote no row (the run's, else the day's). */
export async function capHit(db: D1Database, q: { agent: boolean; runId: string | null; kind: SendKind; atMs: number }): Promise<'run_cap' | 'day_cap'> {
  const group = q.agent ? "source = 'agent'" : "source <> 'agent'"
  const cap = q.agent ? AGENT_CAPS[q.kind].run : SYSTEM_CAPS[q.kind].run
  if (q.runId !== null && cap !== null) {
    const [row] = await all<{ c: number }>(db, stmt(`SELECT count(*) AS c FROM notify_sends WHERE ${group} AND run_id = ? AND kind = ?`, q.runId, q.kind))
    if (row!.c >= cap) return 'run_cap'
  }
  return 'day_cap'
}

/** The hub's answer on a reserved row. Only a row still `reserved` changes (at most once). */
export const settle = (id: string, outcome: Exclude<SendOutcome, 'reserved'>, detail: string | null, slackTs: string | null): Stmt =>
  stmt("UPDATE notify_sends SET outcome = ?, detail = ?, slack_ts = ? WHERE id = ? AND outcome = 'reserved'", outcome, detail, slackTs, id)
