// Support grants (p2-design section 9, BD7). P2's first data PR: what sign-in needs, the live grant and the lazy
// expiry line. Live means `ended_at_ms IS NULL AND ends_at_ms > now`; access never reads `expiry_logged`.
import type { ActiveGrant } from '../auth/principal.ts'
import { auditInsert } from './audit.ts'
import type { AuditHook } from './audit.ts'
import { SYSTEM_MEMBER_ID, writeStamp } from './ids.ts'
import { all, first, runBatch, stmt } from './sql.ts'
import type { Stmt } from './sql.ts'

export interface GrantStoreDeps {
  db: D1Database
  hook?: AuditHook
}

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
        'SELECT id, ends_at_ms FROM support_grants WHERE ended_at_ms IS NULL AND ends_at_ms > ? ORDER BY created_at_ms DESC LIMIT 1', at.nowMs,
      ))
      return live && { id: live.id, endsAtMs: live.ends_at_ms }
    },
    logExpiries,
  }
}

export type GrantStoreImpl = ReturnType<typeof grantStore>
