// The claim (N11): one conditional update from `approved` to `sending`, and what happens when it's refused. The claim
// checks again, in SQL, everything the approval rested on: the row's own state, revision and hold; the gate open, at the
// epoch the approval was given in and at the dispatcher's own pause generation (N12); and permissions/claim-guard.ts
// (the ceiling, the policy, the account, the asker, the channel, and the grant and its use or the approver). A row in
// `sending` is never claimed again: nothing moves a row back to `approved`.
// A refused claim sends nothing. The dispatcher reads why, and moves the row back to `waiting` (the approval cleared,
// the use released, `lapsed_reason` set, the card saying why) or, when the asker left the team or the action can never
// pass again (its account generation or policy revision is gone), to `withdrawn`. An approval not claimed within 10
// minutes of being given lapses (the approval age cap).
import { all, first, stmt } from '../db/sql.ts'
import type { SqlValue, Stmt } from '../db/sql.ts'
import { claimGuardSql } from '../permissions/claim-guard.ts'
import { BULK_RECORDS, POLICY_REV } from '../permissions/policy.ts'
import { operationEntry } from './operations/index.ts'
import { actionLine, both, butNot, releaseUseWhere, stamped, unreleasedUse } from './sql.ts'
import type { LapseReason } from './sql.ts'
import { timing } from './timing.ts'
import type { OutboxActionRow, OutboxGateRow } from './types.ts'

export function claimStmt(p: { actionId: string; nowMs: number; pauseGen: number; stamp: string }): Stmt {
  const guard = claimGuardSql('outbox_actions')
  return stmt(
    `UPDATE outbox_actions SET state = 'sending', rev = rev + 1, attempt = attempt + 1, claimed_at_ms = ?, updated_at_ms = ?, stamp = ?
     WHERE id = ? AND state = 'approved' AND approved_rev = rev AND send_at_ms <= ? AND approved_at_ms > ?
       AND EXISTS (SELECT 1 FROM outbox_gate gt WHERE gt.id = 1 AND gt.paused = 0 AND gt.restore_hold = 0
         AND gt.epoch = outbox_actions.approved_epoch AND gt.do_gen = ?)
       AND ${guard.sql}`,
    p.nowMs, p.nowMs, p.stamp, p.actionId, p.nowMs, p.nowMs - timing().approvalMaxAgeMs, p.pauseGen, ...(guard.params as SqlValue[]),
  )
}

/** Why an approved row can't be claimed now. `wait`: its hold isn't over. `gone`: it isn't approved any more. */
export type ClaimRefusal = { kind: 'wait'; atMs: number } | { kind: 'gone' } | { kind: 'lapse'; reason: LapseReason } | { kind: 'withdraw'; reason: LapseReason }

const exists = async (db: D1Database, sql: string, ...params: (string | number | null)[]) =>
  (await first<{ one: number }>(db, stmt(`SELECT 1 AS one WHERE EXISTS (${sql})`, ...params))) !== null

/**
 * Reads why the claim was refused, in the claim's own order. Throws when nothing explains it: a claim refused for a
 * reason this can't name is a bug, and the task's retries and quarantine make it loud (nothing is sent meanwhile).
 */
export async function whyRefused(db: D1Database, row: OutboxActionRow, nowMs: number, pauseGen: number): Promise<ClaimRefusal> {
  if (row.state !== 'approved' || row.approved_rev !== row.rev) return { kind: 'gone' }
  if (row.send_at_ms === null || row.send_at_ms > nowMs) return { kind: 'wait', atMs: row.send_at_ms ?? nowMs }
  if (row.approved_at_ms === null || row.approved_at_ms <= nowMs - timing().approvalMaxAgeMs) return { kind: 'lapse', reason: 'stale_approval' }
  const gate = await first<OutboxGateRow>(db, stmt('SELECT * FROM outbox_gate WHERE id = 1'))
  if (!gate) throw new Error('outbox: the gate row is missing')
  if (gate.restore_hold === 1) return { kind: 'lapse', reason: 'restore_hold' }
  if (gate.paused === 1 || gate.epoch !== row.approved_epoch || gate.do_gen !== pauseGen) return { kind: 'lapse', reason: 'paused' }
  if (!(await exists(db, 'SELECT 1 FROM permission_ceiling WHERE operation = ? AND enabled = 1', row.operation))) return { kind: 'lapse', reason: 'over_ceiling' }
  const entry = operationEntry(row.operation)
  // A stored action made under another policy, or on another account generation, can never pass again: withdrawn, so
  // a person isn't asked to approve something that can only lapse again.
  if (!entry || row.policy_rev !== POLICY_REV) return { kind: 'withdraw', reason: 'policy_changed' }
  if (!(await exists(db,
    'SELECT 1 FROM connector_accounts WHERE account_id = ? AND connected_at_ms = ? AND (disconnected_at_ms IS NULL OR disconnected_at_ms < connected_at_ms)',
    row.account_id, row.account_gen))) return { kind: 'withdraw', reason: 'account_changed' }
  const people = await all<{ id: string; role: string; kind: string; status: string }>(db, stmt(
    'SELECT id, role, kind, status FROM members WHERE id IN (?, ?)', row.asked_by, row.approved_by ?? row.asked_by,
  ))
  const may = (id: string | null) => {
    const m = people.find(p => p.id === id)
    return m !== undefined && m.kind === 'person' && m.status === 'active' && (m.role === 'admin' || entry.memberMay)
  }
  const asker = people.find(p => p.id === row.asked_by)
  if (!asker || asker.kind !== 'person' || asker.status !== 'active') return { kind: 'withdraw', reason: 'asker_removed' }
  if (!may(row.asked_by)) return { kind: 'lapse', reason: 'approver_not_allowed' }
  if (entry.connector === 'slack') {
    const channelId = (JSON.parse(row.scope_json) as { channelId?: string }).channelId ?? ''
    if (!(await exists(db, 'SELECT 1 FROM notify_channels WHERE channel_id = ? AND removed_at_ms IS NULL', channelId))) return { kind: 'lapse', reason: 'channel_not_listed' }
  }
  if (row.grant_id !== null) {
    if (row.origin === 'routine' || row.records > BULK_RECORDS || Object.values(entry.effects).some(Boolean)) return { kind: 'lapse', reason: 'permission_removed' }
    if (!(await exists(db, 'SELECT 1 FROM permission_uses WHERE id = ? AND grant_id = ? AND released_at_ms IS NULL', `${row.id}#${row.rev}`, row.grant_id))) {
      return { kind: 'lapse', reason: 'count' }
    }
    // Revoked, made under another ceiling or policy, or no longer covering the asker.
    return { kind: 'lapse', reason: 'permission_removed' }
  }
  if (!may(row.approved_by)) return { kind: 'lapse', reason: 'approver_not_allowed' }
  throw new Error(`outbox: the claim of ${row.id} was refused for a reason the dispatcher can't name`)
}

/**
 * An approval that lapsed: the row from `fromState` at `rev` back to `waiting` (or `withdrawn`), the approval and the
 * grant cleared, this revision's use released, and its `action.lapsed` line. `useRev` is the revision its use was
 * reserved at (the approved one). Every statement acts only under this change's stamp.
 */
export function lapseStmts(p: {
  row: Pick<OutboxActionRow, 'id' | 'rev' | 'approved_rev' | 'asked_by'>; fromState: 'approved' | 'sending'; attempt?: number
  to: 'waiting' | 'withdrawn'; reason: LapseReason; nowMs: number; stamp: string; requestId: string; actorId: string
}): Stmt[] {
  const { row } = p
  const mine = stamped(row.id, p.stamp)
  const useRev = row.approved_rev ?? row.rev
  const line = (released: boolean) => ({
    atMs: p.nowMs, actorId: p.actorId, requestId: p.requestId,
    args: { action: 'action.lapsed' as const, actionId: row.id, reason: p.reason, released },
  })
  return [
    stmt(
      `UPDATE outbox_actions SET state = ?, rev = rev + 1, approved_by = NULL, approved_rev = NULL, approved_at_ms = NULL,
         approved_epoch = NULL, send_at_ms = NULL, grant_id = NULL, lapsed_reason = ?, final_at_ms = ?, updated_at_ms = ?, stamp = ?
       WHERE id = ? AND state = ? AND rev = ?${p.fromState === 'sending' ? ' AND attempt = ?' : ''}`,
      p.to, p.reason, p.to === 'withdrawn' ? p.nowMs : null, p.nowMs, p.stamp, row.id, p.fromState, row.rev,
      ...(p.fromState === 'sending' ? [p.attempt ?? -1] : []),
    ),
    actionLine(line(true), both(mine, unreleasedUse(row.id, useRev))),
    actionLine(line(false), butNot(mine, unreleasedUse(row.id, useRev))),
    releaseUseWhere({ actionId: row.id, actionRev: useRev, reason: 'lapsed', atMs: p.nowMs }, mine),
  ]
}
