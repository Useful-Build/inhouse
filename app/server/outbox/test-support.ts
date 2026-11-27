// Helpers for the outbox tests (server/outbox/*.test.ts, in the Workers runtime). Never imported by the Worker. They
// write rows directly: no route writes the ceiling in M2 (N2).
import type { WriteGateway, WriteRequest, WriteResult } from '../../hub/index/contract.ts'
import type { MemberRole } from '../../shared/contract/members.ts'
import { account, ceiling, person, resetPermissions } from '../permissions/test-support.ts'
import type { HubAccountFacts } from './facts.ts'
import { outboxFacts } from './facts.ts'
import type { OutboxNotice } from './notify.ts'
import { openOutbox } from './store.ts'
import { sendAction } from './dispatch.ts'
import type { OutboxActionRow, OutboxRequestCtx } from './types.ts'

export const SHOP_GEN = 1_000
export const ASKER = 'm_ob_asker'
export const ADMIN = 'm_ob_admin'
export const OTHER = 'm_ob_other'

/** Empties the outbox and the permission tables and sets the gate back to its first state. */
export async function resetOutbox(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM outbox_actions'),
    db.prepare('UPDATE outbox_gate SET paused = 0, restore_hold = 0, epoch = 1, do_gen = 0, updated_at_ms = 0 WHERE id = 1'),
    db.prepare("DELETE FROM settings WHERE owner = 'brand' AND key = 'g:tz'"),
  ])
  await resetPermissions(db)
}

/** A brand with the tag operation on, Shopify connected, the asker a member and an admin. */
export async function world(db: D1Database, o: { perDayMax?: number; askerRole?: MemberRole } = {}): Promise<void> {
  await resetOutbox(db)
  await ceiling(db, 'shopify.order.tag_add', { enabled: true, perDayMax: o.perDayMax ?? 50, loweredRev: 1 })
  await account(db, 'shopify:store', SHOP_GEN)
  await person(db, ASKER, o.askerRole ?? 'member')
  await person(db, ADMIN, 'admin')
  await person(db, OTHER, 'member')
}

export const HUB_FACTS: HubAccountFacts[] = [
  { accountId: 'shopify:store', paused: false, label: 'Shopify (Store A)' },
  { accountId: 'slack:workspace', paused: false, label: 'Slack' },
]

let n = 0
/** A fresh id that fits a tool use id, a chat id or a request id. */
export const fresh = (prefix: string): string => `${prefix}_${Date.now().toString(36)}${(++n).toString(36)}`

export const tagArgs = (order: number, tag = 'vip') => ({ orderIds: [`gid://shopify/Order/${order}`], tags: [tag] })

export function requestCtx(o: Partial<OutboxRequestCtx> & { nowMs: number }): OutboxRequestCtx {
  return {
    asker: { memberId: ASKER, role: 'member' }, origin: 'chat', chatId: 'c_ob_chat', jobId: null,
    invocation: { runId: 'r_ob', turnId: 't_ob', toolUseId: fresh('tu') },
    ...o,
  }
}

/** An outbox port over the test D1, its clock, its scheduled sends recorded. */
export function outbox(db: D1Database, now: () => number, scheduled: { id: string; atMs: number }[] = []) {
  return openOutbox({
    db, now, requestId: fresh('req'),
    facts: outboxFacts({ db, hubAccounts: async () => HUB_FACTS }),
    schedule: async (id, atMs) => { scheduled.push({ id, atMs }) },
  })
}

export const rowOf = (db: D1Database, id: string) => db.prepare('SELECT * FROM outbox_actions WHERE id = ?').bind(id).first<OutboxActionRow>()

export const unreleasedUses = async (db: D1Database, actionId: string) =>
  (await db.prepare('SELECT * FROM permission_uses WHERE action_id = ? AND released_at_ms IS NULL').bind(actionId).all<{ id: string; grant_id: string; action_rev: number; units: number }>()).results

/** How the fake hub answers one call. `hang`: never, until the test releases it. */
export type HubMode = 'ok' | 'no' | 'unknown' | 'throw' | 'bad' | 'hang' | 'not_data'

export interface Call { req: WriteRequest; violation: string | null }

/**
 * A fake WriteGateway. Every call is recorded (the effect at the tool), and at call time it reads the row and records
 * a violation when the call didn't follow a winning claim at this attempt, or a grant-backed call has no live use.
 */
export function fakeHub(db: D1Database, next: () => HubMode, onCall?: () => void) {
  const calls: Call[] = []
  const hanging: ((r: WriteResult) => void)[] = []
  const gateway: WriteGateway = {
    async runAction(req) {
      const call: Call = { req, violation: null }
      calls.push(call)
      onCall?.()
      const mode = next()
      const row = await rowOf(db, req.actionId)
      if (!row || row.state !== 'sending' || row.attempt !== req.attempt) call.violation = `call without a winning claim (${row?.state}, attempt ${row?.attempt} vs ${req.attempt})`
      else if (row.grant_id !== null) {
        const use = await db.prepare('SELECT 1 AS one FROM permission_uses WHERE id = ? AND grant_id = ? AND released_at_ms IS NULL')
          .bind(`${row.id}#${row.approved_rev}`, row.grant_id).first()
        if (!use) call.violation = 'a grant-backed call with no live use'
      }
      switch (mode) {
        case 'ok': return { ok: true, value: { ref: 'vip' } }
        case 'no': return { ok: false, error: { code: 'upstream_rejected', message: 'refused' }, sent: 'no' }
        case 'unknown': return { ok: false, error: { code: 'upstream_unavailable', message: 'unclear' }, sent: 'unknown' }
        case 'throw': throw new Error('binding broke')
        case 'bad': return { ok: true, value: { nope: 1 } } as unknown as WriteResult
        case 'hang': return new Promise<WriteResult>(r => { hanging.push(r) })
        // A sure-looking answer with a function in it: not data (a JSON copy used to drop the function and read `sent`).
        case 'not_data': return { ok: true, value: { ref: 'vip', more: () => 1 } } as unknown as WriteResult
      }
    },
  }
  return { gateway, calls, release: (r: WriteResult) => { for (const h of hanging.splice(0)) h(r) } }
}

/** A notifier that records. */
export const notices = (): { list: OutboxNotice[]; notify: (n: OutboxNotice) => Promise<void> } => {
  const list: OutboxNotice[] = []
  return { list, notify: async n => { list.push(n) } }
}

/**
 * One send of an approved action as BrandAgent's `outbox-send` task runs it, through a fake hub that answers `ok` (ref
 * `vip`), at `nowMs`, with the object neither paused nor ever paused. For tests outside the outbox (the egress's) that
 * need a real send without naming the dispatcher (the egress's import boundary).
 */
export async function sendNow(db: D1Database, actionId: string, nowMs: number) {
  const hub = fakeHub(db, () => 'ok')
  await sendAction(actionId, { db, nowMs, hub: hub.gateway, notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: { paused: false, pauseGen: 0 }, timeoutMs: 1_000 })
  return hub
}
