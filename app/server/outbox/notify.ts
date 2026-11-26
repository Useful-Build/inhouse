// The outbox's notices (N11, N12): a lapsed approval, a send that needs a check, an expired card, each to the action's
// approver's bell through the server's own notices (sendSystemNotice: a fixed title per kind, our words in the body, a
// link to the card). A notice that can't be written is logged by the caller and never undoes the change it reports.
import { sendSystemNotice } from '../notify-slack/send.ts'

export type OutboxNoticeKind = 'approval_lapsed' | 'needs_check' | 'approval_expired' | 'approval_failed'

export interface OutboxNotice { kind: OutboxNoticeKind; to: string; actionId: string; key: string; body: string }

export type OutboxNotifier = (n: OutboxNotice) => Promise<void>

/** The real notifier: the approver's bell only (Q3: the server's notices to Slack are the alerts channel's, not these). */
export function outboxNotifier(env: { DB: D1Database; HUB_DELIVERY?: unknown }): OutboxNotifier {
  return async n => {
    const r = await sendSystemNotice(env, {
      key: n.key, source: 'approvals', kind: n.kind, to: { members: [n.to] }, body: n.body, link: { kind: 'approval', id: n.actionId },
    })
    if (!r.ok) throw new Error(`outbox notice refused: ${r.error}`)
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
