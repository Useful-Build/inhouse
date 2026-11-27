// The server's own fixed notices to the alerts channel (Stage 1 M2-N; Wasim, Q3 = A: "the server's own fixed notices (an
// approval is waiting, a routine failed) go to the alerts channel without a card"). Each is a Slack copy only, through
// `sendSystemNotice`: its title is the kind's template, it carries no body (so the post reads "Open Inhouse for the
// details." and never a card's lines or the model's text), and its link opens the card or the routine. The bell side is
// unchanged: a card is in its chat and in Approvals, and a failed routine's bell notices are routines/end.ts's own.
// - Stage 1 M3-X (N25): an admins card (a member's call only an admin may approve) also rings every active admin's bell
//   in the same call, with the same fixed title and no body: never the chat's words.
// - No alerts channel: skipped. No delivery binding or Slack not connected: refused or failed at the hub, never a card.
// - Deduped on a key per card or per run slot, whichever channel holds the mark (send.ts looks the key up without the
//   channel), so a retry, a replayed request or a re-run end task posts once. The sender itself fixes the copy's words
//   and allows it only for these two kinds (send.ts `ALERTS_KINDS`).
// - Not an outbox operation, so the ceiling (N2) doesn't govern it; a card exists only while an operation is enabled, so a
//   build with writes off never sends "approval waiting". "A routine failed" follows the alerts mark wherever it's set.
import { first, stmt } from '../db/sql.ts'
import { activeAdmins, chunks, MEMBERS_PER_NOTICE } from '../outbox/notify.ts'
import { sendSystemNotice } from './send.ts'
import type { SystemNoticeResult } from './send.ts'

type Env = { DB: D1Database; HUB_DELIVERY?: unknown }

/** A run id the notice may carry (`sendSystemNotice` refuses any other shape). */
const RUN_ID = /^r_[A-Za-z0-9_-]{22}$/

function checked(r: SystemNoticeResult, what: string): void {
  if (!r.ok) throw new Error(`${what}: the alerts notice was refused (${r.error})`)
}

/** A new card is waiting (`waiting`, made by `request`): the alerts channel's copy. Anything else (approved under a grant, a replay of a final row) sends nothing. */
export async function alertApprovalWaiting(env: Env, actionId: string, opts: { nowMs?: number } = {}): Promise<void> {
  const row = await first<{ state: string; approver_kind: string }>(env.DB, stmt('SELECT state, approver_kind FROM outbox_actions WHERE id = ?', actionId))
  if (row?.state !== 'waiting') return
  const admins = row.approver_kind === 'admins' ? chunks(await activeAdmins(env.DB), MEMBERS_PER_NOTICE) : []
  for (const [i, members] of (admins.length > 0 ? admins : [[]]).entries()) {
    checked(await sendSystemNotice(env, {
      key: `approval-waiting:${actionId}`, source: 'approvals', kind: 'approval_waiting',
      to: { ...(members.length > 0 ? { members } : {}), ...(i === 0 ? { alertsChannel: true as const } : {}) }, link: { kind: 'approval', id: actionId },
    }, opts), 'approval waiting')
  }
}

/** A routine's run failed (a failure the bell is told about): the alerts channel's copy, once per slot. */
export async function alertRoutineFailed(env: Env, run: { slotKey: string; routineId: string; runId: string | null }, opts: { nowMs?: number } = {}): Promise<void> {
  // The slot key may hold characters a notice key can't: its hash keeps one key per slot.
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(run.slotKey)))
  const key = `routine-failed:${[...d.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')}`
  checked(await sendSystemNotice(env, {
    key, source: 'routines', kind: 'routine_failed', ...(run.runId && RUN_ID.test(run.runId) ? { runId: run.runId } : {}),
    to: { alertsChannel: true }, link: { kind: 'routine', id: run.routineId },
  }, opts), 'routine failed')
}
