// The outbox's notices (N11, N12): a lapsed approval, a send that needs a check, an expired card, each to the action's
// approver's bell through the server's own notices (sendSystemNotice: a fixed title per kind, our words in the body, a
// link to the card). A notice that can't be written is logged by the caller and never undoes the change it reports.
// Stage 1 M3-X (N25): an admins card's approver is no person (`role:admin`): its notices go to the admin who approved it
// while that approval stands (a send that needs a check), else to every active admin (an approval sent back, an expired
// card). A new admins card's bell to every active admin goes with the alerts channel's copy (notify-slack/alerts-notices.ts
// `alertApprovalWaiting`).
import { all, first, stmt } from '../db/sql.ts'
import { sendSystemNotice } from '../notify-slack/send.ts'
import { ADMINS_APPROVER } from './card.ts'

export type OutboxNoticeKind = 'approval_lapsed' | 'needs_check' | 'approval_expired' | 'approval_failed'

export interface OutboxNotice { kind: OutboxNoticeKind; to: string; actionId: string; key: string; body: string }

export type OutboxNotifier = (n: OutboxNotice) => Promise<void>

/** `sendSystemNotice` takes at most this many members in one call. */
export const MEMBERS_PER_NOTICE = 50

/** Every active admin, by id. */
export async function activeAdmins(db: D1Database): Promise<string[]> {
  const rows = await all<{ id: string }>(db, stmt("SELECT id FROM members WHERE kind = 'person' AND status = 'active' AND role = 'admin' ORDER BY id"))
  return rows.map(r => r.id)
}

/**
 * Whom a notice about this action reaches: its approver; for an admins card, the admin whose approval stands (still an
 * active admin), else every active admin.
 */
export async function noticeTargets(db: D1Database, to: string, actionId: string): Promise<string[]> {
  if (to !== ADMINS_APPROVER) return [to]
  const row = await first<{ approved_by: string | null }>(db, stmt(
    `SELECT a.approved_by FROM outbox_actions a WHERE a.id = ? AND a.approver_kind = 'admins'
       AND EXISTS (SELECT 1 FROM members m WHERE m.id = a.approved_by AND m.kind = 'person' AND m.status = 'active' AND m.role = 'admin')`,
    actionId,
  ))
  return row?.approved_by ? [row.approved_by] : activeAdmins(db)
}

export const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

/** The real notifier: the approver's bell only (Q3: the server's notices to Slack are the alerts channel's, not these). */
export function outboxNotifier(env: { DB: D1Database; HUB_DELIVERY?: unknown }): OutboxNotifier {
  return async n => {
    const members = await noticeTargets(env.DB, n.to, n.actionId)
    for (const part of chunks(members, MEMBERS_PER_NOTICE)) {
      const r = await sendSystemNotice(env, {
        key: n.key, source: 'approvals', kind: n.kind, to: { members: part }, body: n.body, link: { kind: 'approval', id: n.actionId },
      })
      if (!r.ok) throw new Error(`outbox notice refused: ${r.error}`)
    }
  }
}

/** Sends each notice; one that fails is logged by name and the rest still go. */
export async function notifyAll(notify: OutboxNotifier, notices: readonly OutboxNotice[]): Promise<void> {
  for (const n of notices) {
    try {
      await notify(n)
    } catch (err) {
      console.error({ event: 'outbox_notice_failed', kind: n.kind, actionId: n.actionId, error: err instanceof Error ? err.name : 'unknown' })
    }
  }
}
