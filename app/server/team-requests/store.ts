// Requests to the Inhouse team (P6a W3, 0470_team_requests.sql). Each write is one batch: the row's statement, guarded by
// `rev`, `status` (and the owner for a withdraw) in its own WHERE, and its audit line guarded on the row this very write
// stamped, so a refused write changes nothing and writes no line. The audit detail holds the id, kind and status, never
// the text. A create is idempotent by request id: a retry (a tool call whose reply was lost) finds the line its first
// try wrote, and answers that request.
import { TEAM_REQUEST_LIST_MAX, TEAM_REQUEST_OPEN_MAX } from '../../shared/contract/team-requests.ts'
import type { TeamRequestStatus } from '../../shared/contract/team-requests.ts'
import { auditInsert } from '../db/audit.ts'
import type { AuditArgs } from '../../shared/contract/audit.ts'
import { writeStamp } from '../db/ids.ts'

export interface TeamRequestRow {
  id: string
  kind: 'tool' | 'job' | 'change' | 'bug' | 'feedback'
  subject: string | null
  text: string
  requested_by: string
  status: TeamRequestStatus
  created_at_ms: number
  updated_at_ms: number
  rev: number
  req_id: string | null
}

export interface At { actorId: string; requestId: string; nowMs: number }
export interface NewRequest { kind: TeamRequestRow['kind']; subject?: string; text: string }

export type CreateOutcome = { ok: TeamRequestRow; created: boolean } | { refused: 'request_limit' }
export type WriteOutcome = { ok: TeamRequestRow } | { conflict: TeamRequestRow } | { refused: 'not_found' | 'not_owner' }

const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
/** `tr_` + 128 random bits (the audit contract's `TeamRequestIdSchema`). */
export const newTeamRequestId = (): string => `tr_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`

const readRow = (db: D1Database, id: string): Promise<TeamRequestRow | null> => db.prepare('SELECT * FROM team_requests WHERE id = ?').bind(id).first<TeamRequestRow>()

function auditStmt(db: D1Database, at: At, args: AuditArgs, id: string, stamp: string): D1PreparedStatement {
  const s = auditInsert({ atMs: at.nowMs, actorId: at.actorId, args, target: { kind: 'team_request', id }, requestId: at.requestId }, { table: 'team_requests', where: 'id = ?', params: [id], stamp })
  return db.prepare(s.sql).bind(...s.params)
}

const written = (r: D1Result, what: string): TeamRequestRow => {
  const row = (r.results as TeamRequestRow[] | undefined)?.[0]
  if (!row) throw new Error(`${what}: the write returned no row`)
  return row
}

/** The request this request id already made, if its first try committed. */
async function madeBefore(db: D1Database, requestId: string): Promise<TeamRequestRow | null> {
  const id = await db.prepare("SELECT target_id FROM audit_log WHERE action = 'team_request.created' AND req_id = ?").bind(requestId).first<string>('target_id')
  return id ? readRow(db, id) : null
}

/** A new open request. Refused at 50 open ones (counted in the statement, so two at once can't both take the last place). */
export async function createRequest(db: D1Database, n: NewRequest, at: At): Promise<CreateOutcome> {
  const before = await madeBefore(db, at.requestId)
  if (before) return { ok: before, created: false }
  const id = newTeamRequestId()
  const stamp = writeStamp(at.requestId)
  const [made] = await db.batch([
    db.prepare(
      `INSERT INTO team_requests (id, kind, subject, text, requested_by, status, created_at_ms, updated_at_ms, rev, req_id)
        SELECT ?, ?, ?, ?, ?, 'open', ?, ?, 1, ?
        WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action = 'team_request.created' AND req_id = ?)
          AND (SELECT count(*) FROM team_requests WHERE status = 'open') < ? RETURNING *`,
    ).bind(id, n.kind, n.subject ?? null, n.text, at.actorId, at.nowMs, at.nowMs, stamp, at.requestId, TEAM_REQUEST_OPEN_MAX),
    auditStmt(db, at, { action: 'team_request.created', requestId: id, kind: n.kind }, id, stamp),
  ])
  if (made.meta.changes === 0) {
    // Either the cap, or a retry that raced its first try.
    const raced = await madeBefore(db, at.requestId)
    return raced ? { ok: raced, created: false } : { refused: 'request_limit' }
  }
  return { ok: written(made, 'createRequest'), created: true }
}

/** Newest first, at most 200, optionally one status. */
export async function listRequests(db: D1Database, status?: TeamRequestStatus): Promise<TeamRequestRow[]> {
  const where = status ? 'WHERE status = ?' : ''
  const stmt = db.prepare(`SELECT * FROM team_requests ${where} ORDER BY created_at_ms DESC, id DESC LIMIT ?`)
  const res = await (status ? stmt.bind(status, TEAM_REQUEST_LIST_MAX) : stmt.bind(TEAM_REQUEST_LIST_MAX)).all<TeamRequestRow>()
  return res.results
}

async function move(db: D1Database, id: string, ifRev: number, status: 'done' | 'declined' | 'withdrawn', at: At, owner: string | null): Promise<WriteOutcome> {
  const stamp = writeStamp(at.requestId)
  const ownerSql = owner === null ? '' : ' AND requested_by = ?'
  const [res] = await db.batch([
    db.prepare(
      `UPDATE team_requests SET status = ?, updated_at_ms = ?, rev = rev + 1, req_id = ?
        WHERE id = ? AND rev = ? AND status = 'open'${ownerSql} RETURNING *`,
    ).bind(status, at.nowMs, stamp, id, ifRev, ...(owner === null ? [] : [owner])),
    auditStmt(db, at, { action: 'team_request.status', requestId: id, status }, id, stamp),
  ])
  if (res.meta.changes > 0) return { ok: written(res, 'move') }
  // Refused: an unknown id is not_found before any owner rule; then the owner; then the row as it is now.
  const row = await readRow(db, id)
  if (!row) return { refused: 'not_found' }
  if (owner !== null && row.requested_by !== owner) return { refused: 'not_owner' }
  return { conflict: row }
}

/** The Inhouse team's answer: done or declined, from `open` only. */
export const setStatus = (db: D1Database, i: { id: string; status: 'done' | 'declined'; ifRev: number }, at: At): Promise<WriteOutcome> =>
  move(db, i.id, i.ifRev, i.status, at, null)

/** The requester takes their own open request back. */
export const withdraw = (db: D1Database, i: { id: string; ifRev: number }, at: At): Promise<WriteOutcome> =>
  move(db, i.id, i.ifRev, 'withdrawn', at, at.actorId)

/** The D1 stores' slot (server/db/stores.ts). */
export function teamRequestStore({ db }: { db: D1Database }) {
  return {
    create: (n: NewRequest, at: At) => createRequest(db, n, at),
    list: (status?: TeamRequestStatus) => listRequests(db, status),
    setStatus: (i: { id: string; status: 'done' | 'declined'; ifRev: number }, at: At) => setStatus(db, i, at),
    withdraw: (i: { id: string; ifRev: number }, at: At) => withdraw(db, i, at),
  }
}
export type TeamRequestStore = ReturnType<typeof teamRequestStore>
