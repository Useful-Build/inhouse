// The restore hold through a real restore (M2-R "Tests", N12): a backup that holds an `approved` and a `sending`
// action, a waiting card the live brand approved after the backup, three it denied, withdrew or let expire after the
// backup, another waiting card, and live grants (one revoked after the backup), restored into a fresh database and reconciled, then a scheduler pass against the fake gateway in a
// fresh BrandAgent (pause generation 0, below the backup's gate). Ways it can fail, written down first:
//  1. something approved or half-sent at the backup, or approved since, is sent again (a call reaches the fake hub), or
//     isn't "Needs a check";
//  2. a grant from the backup still works (one revoked after the backup comes back live);
//  3. a normal Pause and Resume lift the hold, or an answer goes through while it's held;
//  4. the confirm doesn't lift it, or the gate restored ahead of the fresh object never re-seats, so nothing is ever
//     claimed after the confirm (the #433 carry-over);
//  4b. after the confirm (the runbook's order: confirm, switch, then the object syncs), a claim before the first sync
//     wins, or that sync doesn't re-seat the gate and lapse what was approved before it;
//  4c. a card the live brand denied, withdrew or let expire after the backup comes back open, so a person could approve
//     an action already refused;
//  4d. a reconcile that read the record before a concurrent confirm holds the outbox again after the release;
//  5. order: a reconcile stopped before step 4 counts as held, or the confirm goes through without the hold; a re-run
//     of the reconcile refuses on the hold's own audit lines (`audit_conflict`), holds twice or writes its lines twice.
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { beforeAll, expect, it } from 'vitest'
import { SYSTEM_MEMBER_ID } from '../../../server/db/ids.ts'
import { runBatch } from '../../../server/db/sql.ts'
import { openStores } from '../../../server/db/stores.ts'
import { POLICY_REV } from '../../../server/permissions/policy.ts'
import { newPermissionId } from '../../../server/permissions/grants.ts'
import { insertGrant } from '../../../server/permissions/test-support.ts'
import { claimStmt } from '../../../server/outbox/claim.ts'
import { sendAction } from '../../../server/outbox/dispatch.ts'
import { readGate, syncGate } from '../../../server/outbox/gate.ts'
import { holdOutbox } from '../../../server/outbox/restore-hold.ts'
import { sweepOutbox } from '../../../server/outbox/sweep.ts'
import { ASKER, SHOP_GEN, fakeHub, fresh, notices, outbox, requestCtx, rowOf, tagArgs, world } from '../../../server/outbox/test-support.ts'
import { seedBrand } from '../../../server/seed/seed.ts'
import { tables } from '../../tables/index.ts'
import { backup } from '../backup.ts'
import type { RestoreRecord } from '../manifest.ts'
import { restore } from '../restore.ts'
import { restoreStamp } from './audit.ts'
import { confirmRestore, reconcile } from './index.ts'
import { readRecord } from './record.ts'
import { ftsStub } from './test-support.ts'

const e = env as Env & { RESTORE_DB: D1Database; TEST_MIGRATIONS: D1Migration[] }
const T = 1_800_000_000_000
const B = T + 3_600_000
/** The live BrandAgent's pause generation at the backup: the backup's gate holds it. */
const LIVE_GEN = 4
const at = (nowMs: number, actorId = SYSTEM_MEMBER_ID) => ({ actorId, requestId: `req-hold-${nowMs}`, nowMs })
const registry = tables.filter(t => ['members', 'settings', 'support_grants', 'audit_log', 'photos/', 'backups/', 'restore/', 'deletion-log/'].includes(t.name))
const ME = { memberId: ASKER, role: 'member' as const }

let now = T
const clock = () => now
let record: RestoreRecord
let ids: {
  admin: string; inhouse: string; approved: string; sending: string; later: string; waiting: string; grant: string; revokedLater: string
  denied: string; withdrawn: string; expired: string
}
let closedAt: { denied: number; withdrawn: number; expired: number }

const ask = async (db: D1Database, order: number) => {
  const r = await outbox(db, clock).request(requestCtx({ nowMs: now }), { operation: 'shopify.order.tag_add', args: tagArgs(order) }, { mode: 'tool' })
  if (r.outcome !== 'waiting') throw new Error(`expected a card, got ${r.outcome}`)
  return r.action
}
const answer = async (db: D1Database, a: { id: string; rev: number }, choice: 'once' | 'deny' = 'once') => {
  const r = await outbox(db, clock).answer(ME, a.id, { choice, ifRev: a.rev })
  if (!('action' in r)) throw new Error(`answer refused: ${r.refused.code}`)
  return r.action
}
const grantRow = async (scope: string) => {
  const id = newPermissionId()
  await insertGrant(e.DB, {
    id, holder: `member:${ASKER}`, accountId: 'shopify:store', accountGen: SHOP_GEN, operation: 'shopify.order.tag_add', scopeKey: `shop=${scope}`,
    perDay: 5, unitsMax: 1, policyRev: POLICY_REV, grantedRole: 'member', ceilingRev: 1, revokedAtMs: null,
  })
  return id
}
const deps = (fts = ftsStub()) => ({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, rebuildFts: fts.rebuildFts, at: at(B + 60), registry })
const holdLines = async () => (await e.RESTORE_DB.prepare('SELECT id, action, target_id, args_json FROM audit_log WHERE req_id = ? ORDER BY id').bind(restoreStamp(record.restoreId)).all<{ id: number; action: string; target_id: string; args_json: string }>()).results
/** A fresh BrandAgent: generation 0, then whatever Pause and Resume make it. */
const object = { paused: false, pauseGen: 0 }
const send = (actionId: string, hub: ReturnType<typeof fakeHub>) => sendAction(actionId, {
  db: e.RESTORE_DB, nowMs: now, hub: hub.gateway, notify: notices().notify, requestId: fresh('send'), again: () => {}, gate: object, timeoutMs: 5,
})

beforeAll(async () => {
  await applyD1Migrations(e.RESTORE_DB, e.TEST_MIGRATIONS)
  const seeded = await seedBrand(e.DB, openStores(e), T)
  await world(e.DB)
  await e.DB.prepare('UPDATE outbox_gate SET do_gen = ? WHERE id = 1').bind(LIVE_GEN).run()
  const approved = await answer(e.DB, await ask(e.DB, 1))
  const sending = await answer(e.DB, await ask(e.DB, 2))
  const waiting = await ask(e.DB, 3)
  const later = await ask(e.DB, 4)
  const denied = await ask(e.DB, 5)
  const withdrawn = await ask(e.DB, 6)
  const expired = await ask(e.DB, 7)
  now = T + 10_000
  await runBatch(e.DB, [claimStmt({ actionId: sending.id, nowMs: now, pauseGen: LIVE_GEN, stamp: fresh('claim') })])
  expect(await rowOf(e.DB, sending.id)).toMatchObject({ state: 'sending', attempt: 1 })
  const grant = await grantRow('store-a')
  const revokedLater = await grantRow('store-b')
  const manifest = await backup({ db: e.DB, bucket: e.FILES, nowMs: B })
  // After the backup, live: the later card is approved, a grant is revoked, and three cards close (denied, withdrawn, expired).
  now = B + 10
  await answer(e.DB, later)
  await e.DB.prepare("UPDATE permission_grants SET revoked_at_ms = ?, revoked_by = ?, revoke_reason = 'removed', rev = rev + 1 WHERE id = ?").bind(now, ASKER, revokedLater).run()
  now = B + 11
  await answer(e.DB, denied, 'deny')
  now = B + 12
  const w = await outbox(e.DB, clock).withdraw({ kind: 'member', actor: ME }, withdrawn.id, { ifRev: withdrawn.rev })
  if (!('action' in w)) throw new Error(`withdraw refused: ${w.refused.code}`)
  await e.DB.prepare('UPDATE outbox_actions SET expires_at_ms = ? WHERE id = ?').bind(B + 13, expired.id).run()
  await sweepOutbox({ db: e.DB, nowMs: B + 14, state: () => ({ paused: false, pauseGen: LIVE_GEN }), scheduler: { ensure: () => {} }, notify: notices().notify, requestId: fresh('live-sweep') })
  for (const [id, state] of [[denied.id, 'denied'], [withdrawn.id, 'withdrawn'], [expired.id, 'expired']] as const) expect(await rowOf(e.DB, id), state).toMatchObject({ state })
  closedAt = { denied: B + 11, withdrawn: B + 12, expired: B + 14 }
  ids = {
    admin: seeded.members.admin, inhouse: seeded.members.inhouse, approved: approved.id, sending: sending.id, later: later.id, waiting: waiting.id, grant, revokedLater,
    denied: denied.id, withdrawn: withdrawn.id, expired: expired.id,
  }
  record = await restore({ bucket: e.FILES, target: e.RESTORE_DB, live: e.DB, backupId: manifest.backupId, at: at(B + 50), durableObjects: [{ name: 'BrandAgent', recoveredAtMs: B }] })
  expect(record, record.reason).toMatchObject({ status: 'restored_unreconciled' })
})

it('a reconcile stopped before step 4 holds nothing and the confirm refuses (failure 5)', async () => {
  expect(await reconcile(deps(ftsStub('failed')))).toMatchObject({ refused: expect.stringMatching(/^fts_rebuild_failed/) })
  expect((await readRecord(e.FILES, record.restoreId)).record.reconcile).toMatchObject({ outbox: null })
  expect(await readGate(e.RESTORE_DB)).toMatchObject({ restore_hold: 0, do_gen: LIVE_GEN })
  expect(await holdLines()).toEqual([])
  expect(await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(B + 55, ids.inhouse), approvedBy: ids.admin }))
    .toMatchObject({ refused: 'not_reconciled: audit' })
})

it('reconciles: the gate held and re-seated, everything that may have gone out to "Needs a check", every grant revoked (failures 1, 2, 5)', async () => {
  const out = await reconcile(deps())
  if (!('ok' in out)) throw new Error(out.refused)
  const held = [ids.approved, ids.later, ids.sending].sort()
  const revoked = [ids.grant, ids.revokedLater].sort()
  const closed = [ids.denied, ids.withdrawn, ids.expired].sort()
  expect(out.ok.reconcile?.outbox).toEqual({ held, revoked, closed })
  // Closed again as the live brand closed them, at the live line's time; no new line.
  for (const k of ['denied', 'withdrawn', 'expired'] as const) {
    expect(await rowOf(e.RESTORE_DB, ids[k]), k).toMatchObject({ state: k, final_at_ms: closedAt[k], lapsed_reason: k === 'expired' ? 'expired' : null })
  }
  expect(await readGate(e.RESTORE_DB)).toMatchObject({ restore_hold: 1, do_gen: -1 })
  for (const id of held) expect(await rowOf(e.RESTORE_DB, id), id).toMatchObject({ state: 'needs_check' })
  expect(await rowOf(e.RESTORE_DB, ids.waiting)).toMatchObject({ state: 'waiting' })
  for (const id of revoked) {
    expect(await e.RESTORE_DB.prepare('SELECT revoke_reason, revoked_by FROM permission_grants WHERE id = ?').bind(id).first(), id).toEqual({ revoke_reason: 'restore', revoked_by: SYSTEM_MEMBER_ID })
  }
  const lines = await holdLines()
  expect(lines.filter(l => l.action === 'action.needs_check').map(l => [l.target_id, JSON.parse(l.args_json)]).sort())
    .toEqual([
      [ids.approved, { actionId: ids.approved, why: 'restore' }],
      [ids.later, { actionId: ids.later, why: 'restore' }],
      [ids.sending, { actionId: ids.sending, attempt: 1, why: 'restore' }],
    ].sort())
  expect(lines.filter(l => l.action === 'permission.revoked').map(l => l.target_id).sort()).toEqual(revoked)

  // A re-run: no audit_conflict on the hold's own lines, nothing held or written twice.
  const again = await reconcile(deps())
  if (!('ok' in again)) throw new Error(again.refused)
  expect(again.ok.reconcile?.outbox).toEqual({ held, revoked, closed })
  expect(await holdLines()).toEqual(lines)
})

it('a scheduler pass in a fresh BrandAgent sends nothing; a Pause and a Resume re-seat the gate and never lift the hold (failures 1, 3)', async () => {
  now = B + 120_000
  const hub = fakeHub(e.RESTORE_DB, () => 'ok')
  const swept = await sweepOutbox({ db: e.RESTORE_DB, nowMs: now, state: () => object, scheduler: { ensure: () => {} }, notify: notices().notify, requestId: fresh('sweep') })
  expect(swept).toMatchObject({ synced: true, rescheduled: 0, stale: 0 })
  expect(await readGate(e.RESTORE_DB)).toMatchObject({ restore_hold: 1, do_gen: 0 })
  for (const id of Object.values(ids).filter(id => id.startsWith('ac_'))) expect(await send(id, hub), id).toEqual({ kind: 'not_claimed' })
  // A closed card can't be answered.
  const closedCard = await rowOf(e.RESTORE_DB, ids.denied)
  expect(await outbox(e.RESTORE_DB, clock).answer(ME, ids.denied, { choice: 'once', ifRev: closedCard?.rev ?? 0 })).toHaveProperty('refused')
  expect(hub.calls).toEqual([])

  for (const paused of [true, false]) {
    object.paused = paused
    object.pauseGen += 1
    await syncGate({ db: e.RESTORE_DB, state: () => object, nowMs: now, requestId: fresh('sync'), notify: notices().notify })
    expect(await readGate(e.RESTORE_DB)).toMatchObject({ restore_hold: 1, do_gen: object.pauseGen, paused: paused ? 1 : 0 })
  }
  const card = await rowOf(e.RESTORE_DB, ids.waiting)
  expect(await outbox(e.RESTORE_DB, clock).answer(ME, ids.waiting, { choice: 'once', ifRev: card?.rev ?? 0 })).toMatchObject({ refused: { code: 'conflict' } })
  expect(await rowOf(e.RESTORE_DB, ids.waiting)).toMatchObject({ state: 'waiting' })
})

it('the confirm lifts the hold; in the runbook order the first claim waits for a sync, then an approval is claimed (failures 4, 4b)', async () => {
  const done = await confirmRestore({ bucket: e.FILES, target: e.RESTORE_DB, restoreId: record.restoreId, at: at(B + 130_000, ids.inhouse), approvedBy: ids.admin })
  if (!('ok' in done)) throw new Error(done.refused)
  expect(done.ok).toMatchObject({ status: 'restored', reconcile: { outbox: { held: [ids.approved, ids.later, ids.sending].sort() } } })
  // The release sets do_gen back to -1: the syncs made before the confirm count for nothing.
  expect(await readGate(e.RESTORE_DB)).toMatchObject({ restore_hold: 0, do_gen: -1 })
  const hub = fakeHub(e.RESTORE_DB, () => 'ok')
  const approveWaiting = async () => {
    const card = await rowOf(e.RESTORE_DB, ids.waiting)
    await answer(e.RESTORE_DB, { id: ids.waiting, rev: card?.rev ?? 0 })
  }
  // After the switch, before the object's first sync: the answer goes through, the claim is refused, no call.
  now = B + 140_000
  await approveWaiting()
  now += 10_000
  expect(await send(ids.waiting, hub)).toEqual({ kind: 'not_claimed' })
  expect(await rowOf(e.RESTORE_DB, ids.waiting)).toMatchObject({ state: 'waiting', lapsed_reason: 'paused' })
  // Approved again, then the first sync (the sweep) re-seats the gate and lapses that approval.
  await approveWaiting()
  const swept = await sweepOutbox({ db: e.RESTORE_DB, nowMs: now, state: () => object, scheduler: { ensure: () => {} }, notify: notices().notify, requestId: fresh('sweep') })
  expect(swept).toMatchObject({ synced: true })
  expect(await readGate(e.RESTORE_DB)).toMatchObject({ restore_hold: 0, do_gen: object.pauseGen })
  expect(await rowOf(e.RESTORE_DB, ids.waiting)).toMatchObject({ state: 'waiting', lapsed_reason: 'paused' })
  expect(hub.calls).toEqual([])
  // Now an approval is claimed and sent.
  await approveWaiting()
  now += 10_000
  expect(await send(ids.waiting, hub)).toMatchObject({ kind: 'sent' })
  // The held rows are still never sent by the system.
  for (const id of [ids.approved, ids.later, ids.sending]) expect(await send(id, hub), id).toEqual({ kind: 'not_claimed' })
  expect(hub.calls.map(c => [c.req.actionId, c.violation])).toEqual([[ids.waiting, null]])
})

it('a step 4 that runs after the confirm (a reconcile that read the record first) holds nothing again (failure 4d)', async () => {
  const gate = await readGate(e.RESTORE_DB)
  const rows = (await e.RESTORE_DB.prepare('SELECT * FROM outbox_actions ORDER BY id').all()).results
  const grants = (await e.RESTORE_DB.prepare('SELECT * FROM permission_grants ORDER BY id').all()).results
  const lines = await holdLines()
  const stale = await holdOutbox(e.RESTORE_DB, { restoreId: record.restoreId, afterId: 0, gap: true, at: { nowMs: B + 200_000, actorId: SYSTEM_MEMBER_ID, requestId: restoreStamp(record.restoreId) } })
  expect(stale.held).toEqual([ids.approved, ids.later, ids.sending].sort())
  expect(await readGate(e.RESTORE_DB)).toEqual(gate)
  expect(gate.restore_hold).toBe(0)
  expect((await e.RESTORE_DB.prepare('SELECT * FROM outbox_actions ORDER BY id').all()).results).toEqual(rows)
  expect((await e.RESTORE_DB.prepare('SELECT * FROM permission_grants ORDER BY id').all()).results).toEqual(grants)
  expect(await holdLines()).toEqual(lines)
  // And the reconcile itself refuses a restored record.
  expect(await reconcile(deps())).toMatchObject({ refused: 'not_reconcilable: restored' })
})
