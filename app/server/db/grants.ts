// Support grants (p2-design section 9, BD7): what sign-in needs (the live grant, the lazy expiry line) and the grants
// routes (list, create, end). Live means `ended_at_ms IS NULL AND ends_at_ms > now`; access never reads
// `expiry_logged`. Every guard is in the statement: one live grant at a time, an end only of a live grant at its rev.
import type { GrantHours, SupportGrant } from '../../shared/contract/grants.ts'
import type { ActiveGrant } from '../auth/principal.ts'
import { auditInsert } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { SYSTEM_MEMBER_ID, newGrantId, writeStamp } from './ids.ts'
import type { At, Outcome } from './members.ts'
import { all, first, runBatch, stmt } from './sql.ts'
import type { Stmt } from './sql.ts'

export interface GrantStoreDeps {
  db: D1Database
  hook?: AuditHook
}

interface GrantRow {
  id: string
  created_by: string
  created_at_ms: number
  ends_at_ms: number
  ended_at_ms: number | null
  ended_by: string | null
  rev: number
}

const instant = (ms: number) => ({ iso: new Date(ms).toISOString(), ms })

/** A grant as the API serves it; `live` at `nowMs`. */
export const grantRecord = (r: GrantRow, nowMs: number): SupportGrant => ({
  id: r.id,
  createdBy: r.created_by,
  createdAt: instant(r.created_at_ms),
  endsAt: instant(r.ends_at_ms),
  endedAt: r.ended_at_ms === null ? null : instant(r.ended_at_ms),
  endedBy: r.ended_by,
  rev: r.rev,
  live: r.ended_at_ms === null && r.ends_at_ms > nowMs,
})

/** The live condition at a bound `?` (now). */
const LIVE = 'ended_at_ms IS NULL AND ends_at_ms > ?'

export function grantStore({ db, hook = s => s }: GrantStoreDeps) {
  const write = (stmts: Stmt[]) => runBatch(db, stmts.map(s => (s.sql.startsWith('INSERT INTO audit_log') ? hook(s) : s)))

  /**
   * Writes `grant.expired` (actor `system`, at `ends_at_ms`) for every grant that ran out unended and isn't logged yet.
   * The flag's guard is in the statement, so two requests at once log each expiry once.
   */
  const logExpiries = async (at: { nowMs: number; requestId: string }): Promise<void> => {
    const due = await all<{ id: string; ends_at_ms: number }>(db, stmt(
      'SELECT id, ends_at_ms FROM support_grants WHERE expiry_logged = 0 AND ended_at_ms IS NULL AND ends_at_ms <= ? ORDER BY ends_at_ms', at.nowMs,
    ))
    for (const g of due) {
      const stamp = writeStamp(at.requestId)
      // Its own batch per grant: one line per expiry, written once (the flag's guard).
      await write([
        stmt(
          'UPDATE support_grants SET expiry_logged = 1, req_id = ? WHERE id = ? AND expiry_logged = 0 AND ended_at_ms IS NULL AND ends_at_ms <= ?',
          stamp, g.id, at.nowMs,
        ),
        auditInsert(
          { atMs: g.ends_at_ms, actorId: SYSTEM_MEMBER_ID, args: { action: 'grant.expired', grantId: g.id }, target: { kind: 'grant', id: g.id }, requestId: at.requestId },
          { table: 'support_grants', where: 'id = ?', params: [g.id], stamp },
        ),
      ])
    }
  }

  return {
    /** The grant live at `nowMs`, or null; logs any expiry it finds first. */
    async active(at: { nowMs: number; requestId: string }): Promise<ActiveGrant | null> {
      await logExpiries(at)
      const live = await first<{ id: string; ends_at_ms: number }>(db, stmt(
        `SELECT id, ends_at_ms FROM support_grants WHERE ${LIVE} ORDER BY created_at_ms DESC LIMIT 1`, at.nowMs,
      ))
      return live && { id: live.id, endsAtMs: live.ends_at_ms }
    },
    logExpiries,

    /** The most recent grants, newest first (the live one, if any, among them); logs any expiry first. */
    async list(at: { nowMs: number; requestId: string }, limit = 20): Promise<SupportGrant[]> {
      await logExpiries(at)
      const rows = await all<GrantRow>(db, stmt('SELECT * FROM support_grants ORDER BY created_at_ms DESC, id DESC LIMIT ?', limit))
      return rows.map(r => grantRecord(r, at.nowMs))
    },

    /** A new grant of `hours`, only while none is live (checked in the insert), with its `grant.created` line. */
    async create(hours: GrantHours, at: At): Promise<{ ok: SupportGrant } | { refused: 'grant_live' }> {
      await logExpiries(at)
      const id = newGrantId()
      const stamp = writeStamp(at.requestId)
      const [insert] = await write([
        stmt(
          `INSERT INTO support_grants (id, created_by, created_at_ms, ends_at_ms, req_id)
           SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM support_grants WHERE ${LIVE})`,
          id, at.actorId, at.nowMs, at.nowMs + hours * 3_600_000, stamp, at.nowMs,
        ),
        auditInsert(
          { atMs: at.nowMs, actorId: at.actorId, args: { action: 'grant.created', grantId: id, hours }, target: { kind: 'grant', id }, requestId: at.requestId },
          { table: 'support_grants', where: 'id = ?', params: [id], stamp },
        ),
      ])
      if (insert.meta.changes === 0) return { refused: 'grant_live' }
      const r = await first<GrantRow>(db, stmt('SELECT * FROM support_grants WHERE id = ?', id))
      if (!r) throw new Error('create: no grant after the insert')
      return { ok: grantRecord(r, at.nowMs) }
    },

    /** Ends a live grant at once, at its rev, with its `grant.ended` line. */
    async end(input: { id: string; ifRev: number }, at: At): Promise<Outcome<SupportGrant, 'not_found'>> {
      const stamp = writeStamp(at.requestId)
      const [change] = await write([
        stmt(
          `UPDATE support_grants SET ended_at_ms = ?, ended_by = ?, rev = rev + 1, req_id = ? WHERE id = ? AND rev = ? AND ${LIVE}`,
          at.nowMs, at.actorId, stamp, input.id, input.ifRev, at.nowMs,
        ),
        auditInsert(
          { atMs: at.nowMs, actorId: at.actorId, args: { action: 'grant.ended', grantId: input.id }, target: { kind: 'grant', id: input.id }, requestId: at.requestId },
          { table: 'support_grants', where: 'id = ?', params: [input.id], stamp },
        ),
      ])
      const r = await first<GrantRow>(db, stmt('SELECT * FROM support_grants WHERE id = ?', input.id))
      if (!r) return { refused: 'not_found' }
      // Not applied: a stale rev, or a grant that has already ended or run out. Either way the record as it is now.
      return change.meta.changes > 0 ? { ok: grantRecord(r, at.nowMs) } : { conflict: grantRecord(r, at.nowMs) }
    },
  }
}

export type GrantStoreImpl = ReturnType<typeof grantStore>
